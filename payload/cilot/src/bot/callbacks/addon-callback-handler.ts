import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { InlineKeyboard, type Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { isAdminUser } from "../../app/services/access-control.js";
import {
  configuredAccountIds,
  grantOf,
  readAddonPolicy,
  setDefaultPolicy,
  setGrant,
} from "../../app/services/addon-policy-service.js";
import {
  AddonConfigError,
  defaultProfile,
  ensureAccountProfile,
  parseFieldInput,
  readProfile,
  removeAccountProfile,
  setProfileField,
  summarizeProfile,
  type AddonProfile,
} from "../../app/services/addon-config-service.js";
import {
  getInstalledAddon,
  type AddonConfigField,
  type InstalledAddon,
} from "../../app/services/addon-manifest-service.js";
import {
  disableAddon,
  enabledAddonIds,
  enableAddon,
  listPermissionAgents,
  restartServer,
} from "../../app/services/addon-registry-service.js";
import {
  allRequiredSecretsSet,
  deleteSecret,
  secretStatus,
  setSecret,
} from "../../app/services/addon-secret-service.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { userWorkspaceBase, userWorkspaceRoot } from "../../app/services/workspace-paths.js";
import { buildListItems } from "../commands/addons-command.js";
import {
  ADDONS_ACCOUNTS,
  ADDONS_CALLBACK_PREFIX,
  ADDONS_CANCEL,
  ADDONS_DEFAULT_CONFIRM,
  ADDONS_DISABLE_CONFIRM,
  ADDONS_ENABLE,
  ADDONS_ENABLE_CONFIRM,
  ADDONS_FIELD,
  ADDONS_LIST,
  ADDONS_OPEN,
  ADDONS_SECRET,
  ADDONS_SET_CONFIRM,
  buildAccountKeyboard,
  buildAccountText,
  buildAccountsKeyboard,
  buildAccountsText,
  buildAddonsListKeyboard,
  buildAddonsListText,
  buildConfirmKeyboard,
  buildDefaultConfirmText,
  buildDetailKeyboard,
  buildDetailText,
  buildDisableConfirmText,
  buildEnableConfirmText,
  buildFieldKeyboard,
  buildFieldText,
  buildModeConfirmText,
  buildProfileKeyboard,
  buildProfileText,
  buildSecretEntryKeyboard,
  buildSecretEntryText,
  buildSecretsKeyboard,
  buildSecretsText,
} from "../menus/addon-menu.js";
import { cancelMenu } from "./feedback.js";

/**
 * The `/addons` screens and the text answers they wait for.
 *
 * This file is one entry point for callbacks and one for text because both have to repeat
 * the same checks: an id comes from `ctx.from`, never from a callback argument, and only an
 * admin may edit a profile, a grant or a credential. A standard account reaches the list,
 * its own detail, Test and "ask an admin"; everything else is refused here even though the
 * keyboard does not show it.
 */

const execFileAsync = promisify(execFile);

type AddonStage =
  | "list"
  | "detail"
  | "accounts"
  | "account"
  | "profile"
  | "field"
  | "secrets"
  | "secret_entry"
  | "enable_confirm"
  | "disable_confirm"
  | "default_confirm"
  | "mode_confirm"
  | "await_account_id"
  | "await_field_value"
  | "await_secret_value";

const VALID_STAGES: readonly AddonStage[] = [
  "list",
  "detail",
  "accounts",
  "account",
  "profile",
  "field",
  "secrets",
  "secret_entry",
  "enable_confirm",
  "disable_confirm",
  "default_confirm",
  "mode_confirm",
  "await_account_id",
  "await_field_value",
  "await_secret_value",
];

const TEXT_STAGES: readonly AddonStage[] = [
  "await_account_id",
  "await_field_value",
  "await_secret_value",
];

interface AddonsMetadata {
  flow: "addons";
  stage: AddonStage;
  messageId: number;
  addonId?: string;
  accountId?: number;
  fieldKey?: string;
  secretKey?: string;
  agents?: string[];
  value?: string;
}

export type AddonsDeps = Pick<
  AppContainer,
  "interactionManager" | "foregroundSessionState" | "attachManager"
>;

export function parseAddonsMetadata(state: unknown): AddonsMetadata | null {
  if (!state || typeof state !== "object") return null;
  const snapshot = state as { kind?: string; metadata?: Record<string, unknown> };
  if (snapshot.kind !== "custom" || !snapshot.metadata) return null;

  const metadata = snapshot.metadata;
  if (metadata.flow !== "addons" || typeof metadata.stage !== "string") return null;
  const stage = metadata.stage as AddonStage;
  if (!VALID_STAGES.includes(stage)) return null;
  if (typeof metadata.messageId !== "number") return null;

  const parsed: AddonsMetadata = { flow: "addons", stage, messageId: metadata.messageId };
  if (typeof metadata.addonId === "string") parsed.addonId = metadata.addonId;
  if (typeof metadata.accountId === "number" && Number.isInteger(metadata.accountId)) {
    parsed.accountId = metadata.accountId;
  }
  if (typeof metadata.fieldKey === "string") parsed.fieldKey = metadata.fieldKey;
  if (typeof metadata.secretKey === "string") parsed.secretKey = metadata.secretKey;
  if (
    Array.isArray(metadata.agents) &&
    metadata.agents.every((entry): entry is string => typeof entry === "string")
  ) {
    parsed.agents = metadata.agents;
  }
  if (typeof metadata.value === "string") parsed.value = metadata.value;
  return parsed;
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function clearInteraction(deps: AddonsDeps, reason: string): void {
  if (parseAddonsMetadata(deps.interactionManager.getSnapshot())) {
    deps.interactionManager.clear(reason);
  }
}

function setStage(deps: AddonsDeps, metadata: AddonsMetadata): void {
  deps.interactionManager.transition({
    expectedInput: TEXT_STAGES.includes(metadata.stage) ? "mixed" : "callback",
    metadata: { ...metadata },
  });
}

async function editMenu(
  ctx: Context,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  if (!ctx.chat) return;
  try {
    await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard });
  } catch (error) {
    const description = (error as { description?: string }).description ?? "";
    if (!description.includes("message is not modified")) throw error;
  }
}

async function ack(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
}

async function inactive(ctx: Context): Promise<void> {
  await ctx
    .answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true })
    .catch(() => {});
}

// --------------------------------------------------------------- rendering

async function renderList(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  userId: number,
  isAdmin: boolean,
): Promise<void> {
  const items = await buildListItems(userId, isAdmin);
  const keyboard =
    items.length > 0
      ? buildAddonsListKeyboard(items)
      : new InlineKeyboard().text(t("inline.button.cancel"), ADDONS_CANCEL);
  await editMenu(ctx, messageId, buildAddonsListText(items, isAdmin), keyboard);
  setStage(deps, { flow: "addons", stage: "list", messageId });
}

async function loadAddon(ctx: Context, addonId: string): Promise<InstalledAddon | null> {
  const addon = await getInstalledAddon(addonId);
  if (!addon) await inactive(ctx);
  return addon;
}

async function renderDetail(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  userId: number,
  isAdmin: boolean,
): Promise<void> {
  const enabled = (await enabledAddonIds()).has(addon.id);
  const perUser = addon.manifest?.scope === "per-user";

  let granted = 0;
  let total = 0;
  let policyDefault = "admin-only";
  if (perUser) {
    const policy = await readAddonPolicy(addon.id);
    const ids = await configuredAccountIds(addon.id);
    total = ids.length;
    granted = ids.filter((id) => grantOf(policy, id) === "use").length;
    policyDefault = policy.default;
  }

  const profile = await readProfile(addon, userId)
    .then((result) => result.profile)
    .catch(async () => defaultProfile(addon));
  const summary = summarizeProfile(
    addon.manifest,
    profile,
    Object.keys(addon.manifest?.config ?? {}),
  );
  const credentialsSet = await allRequiredSecretsSet(addon, perUser ? userId : null);

  const text = buildDetailText({
    addon,
    enabled,
    granted,
    total,
    policyDefault,
    profileSummary: summary || "—",
    credentialsSet,
    isAdmin,
  });
  await editMenu(
    ctx,
    messageId,
    text,
    buildDetailKeyboard({ addon, enabled, accountId: userId, isAdmin }),
  );
  setStage(deps, {
    flow: "addons",
    stage: "detail",
    messageId,
    addonId: addon.id,
    accountId: userId,
  });
}

async function renderAccounts(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
): Promise<void> {
  if (addon.manifest?.scope !== "per-user") {
    await inactive(ctx);
    return;
  }

  const policy = await readAddonPolicy(addon.id);
  const ids = await configuredAccountIds(addon.id);
  const rows = [];
  for (const id of ids) {
    const configured = await readProfile(addon, id)
      .then((result) => result.exists)
      .catch(() => false);
    rows.push({ accountId: id, grant: grantOf(policy, id), configured });
  }

  await editMenu(
    ctx,
    messageId,
    buildAccountsText(addon, rows),
    buildAccountsKeyboard(addon, rows),
  );
  setStage(deps, { flow: "addons", stage: "accounts", messageId, addonId: addon.id });
}

async function renderAccount(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  accountId: number,
): Promise<void> {
  const policy = await readAddonPolicy(addon.id);
  const grant = grantOf(policy, accountId);
  const profile = await readProfile(addon, accountId)
    .then((result) => result.profile)
    .catch(async () => defaultProfile(addon));

  await editMenu(
    ctx,
    messageId,
    buildAccountText(addon, accountId, grant, profile),
    buildAccountKeyboard(addon, accountId, grant, profile),
  );
  setStage(deps, {
    flow: "addons",
    stage: "account",
    messageId,
    addonId: addon.id,
    accountId,
  });
}

async function renderProfile(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  accountId: number,
): Promise<void> {
  const profile = await readProfile(addon, accountId)
    .then((result) => result.profile)
    .catch(async () => defaultProfile(addon));

  await editMenu(
    ctx,
    messageId,
    buildProfileText(addon, profile, accountId),
    buildProfileKeyboard(addon, profile, accountId),
  );
  setStage(deps, {
    flow: "addons",
    stage: "profile",
    messageId,
    addonId: addon.id,
    accountId,
  });
}

function fieldOf(addon: InstalledAddon, key: string): AddonConfigField | null {
  return addon.manifest?.config?.[key] ?? null;
}

async function renderField(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  accountId: number,
  key: string,
): Promise<void> {
  const field = fieldOf(addon, key);
  if (!field) {
    await renderProfile(ctx, deps, messageId, addon, accountId);
    return;
  }
  const profile = await readProfile(addon, accountId)
    .then((result) => result.profile)
    .catch(async () => defaultProfile(addon));

  await editMenu(
    ctx,
    messageId,
    buildFieldText(field, key, profile),
    buildFieldKeyboard(addon, profile, accountId, key, field),
  );
  setStage(deps, {
    flow: "addons",
    stage: "field",
    messageId,
    addonId: addon.id,
    accountId,
    fieldKey: key,
  });
}

async function renderSecrets(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  accountId: number,
): Promise<void> {
  const status = await secretStatus(addon, accountId);
  await editMenu(
    ctx,
    messageId,
    buildSecretsText(addon, accountId, status),
    buildSecretsKeyboard(addon, accountId, status),
  );
  setStage(deps, {
    flow: "addons",
    stage: "secrets",
    messageId,
    addonId: addon.id,
    accountId,
  });
}

async function renderSecretEntry(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  accountId: number,
  key: string,
): Promise<void> {
  const status = await secretStatus(addon, accountId);
  const entry = status.find((candidate) => candidate.key === key);
  if (!entry) {
    await renderSecrets(ctx, deps, messageId, addon, accountId);
    return;
  }

  await editMenu(
    ctx,
    messageId,
    buildSecretEntryText(addon, entry),
    buildSecretEntryKeyboard(addon, accountId, entry),
  );
  setStage(deps, {
    flow: "addons",
    stage: "secret_entry",
    messageId,
    addonId: addon.id,
    accountId,
    secretKey: key,
  });
}

async function renderEnableConfirm(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  agents: string[],
): Promise<void> {
  let accounts = 0;
  if (addon.manifest?.scope === "per-user") {
    const policy = await readAddonPolicy(addon.id);
    accounts = (await configuredAccountIds(addon.id)).filter(
      (id) => grantOf(policy, id) === "use",
    ).length;
  }

  await editMenu(
    ctx,
    messageId,
    buildEnableConfirmText(addon, accounts, agents),
    buildConfirmKeyboard(`${ADDONS_ENABLE_CONFIRM}:${addon.id}`, `${ADDONS_ENABLE}:${addon.id}`),
  );
  setStage(deps, {
    flow: "addons",
    stage: "enable_confirm",
    messageId,
    addonId: addon.id,
    agents,
  });
}

async function renderDisableConfirm(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
): Promise<void> {
  await editMenu(
    ctx,
    messageId,
    buildDisableConfirmText(addon),
    buildConfirmKeyboard(`${ADDONS_DISABLE_CONFIRM}:${addon.id}`, `${ADDONS_OPEN}:${addon.id}`),
  );
  setStage(deps, { flow: "addons", stage: "disable_confirm", messageId, addonId: addon.id });
}

async function renderDefaultConfirm(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
): Promise<void> {
  await editMenu(
    ctx,
    messageId,
    buildDefaultConfirmText(addon),
    buildConfirmKeyboard(`${ADDONS_DEFAULT_CONFIRM}:${addon.id}`, `${ADDONS_OPEN}:${addon.id}`),
  );
  setStage(deps, { flow: "addons", stage: "default_confirm", messageId, addonId: addon.id });
}

async function renderModeConfirm(
  ctx: Context,
  deps: AddonsDeps,
  messageId: number,
  addon: InstalledAddon,
  accountId: number,
): Promise<void> {
  await editMenu(
    ctx,
    messageId,
    buildModeConfirmText(accountId),
    buildConfirmKeyboard(
      `${ADDONS_SET_CONFIRM}:${addon.id}:${accountId}:mailbox`,
      `${ADDONS_FIELD}:${addon.id}:${accountId}:mode`,
    ),
  );
  setStage(deps, {
    flow: "addons",
    stage: "mode_confirm",
    messageId,
    addonId: addon.id,
    accountId,
    fieldKey: "mode",
    value: "mailbox",
  });
}

// --------------------------------------------------------------- self-test

interface SelfTestResult {
  ok: boolean;
  account?: string;
  mode?: string;
  folders?: number;
  unread?: number;
  error?: string;
}

async function runSelfTest(addon: InstalledAddon, accountId: number): Promise<string> {
  const entry = addon.manifest
    ? `${addon.root}/${addon.manifest.entry}`
    : `${addon.root}/dist/server.js`;

  const cwd = userWorkspaceRoot(accountId);
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 }).catch(() => {});

  try {
    const { stdout } = await execFileAsync(process.execPath, [entry, "--selftest"], {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CILOT_ADDON_ID: addon.id,
        CILOT_ADDON_CONFIG_ROOT: addon.configRoot,
        CILOT_ADDON_STATE_ROOT: addon.stateRoot,
        CILOT_USER_ROOT: userWorkspaceBase(),
      },
    });
    const result = parseSelfTest(stdout);
    return result.ok
      ? t("addons.test.ok", { messages: String(result.folders ?? 0) })
      : t("addons.test.failed", { code: result.error ?? "unknown" });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    const result = parseSelfTest(stdout);
    return t("addons.test.failed", {
      code: result.error ?? (error as NodeJS.ErrnoException).code ?? "unknown",
    });
  }
}

function parseSelfTest(stdout: string): SelfTestResult {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return { ok: false, error: "no output" };
  try {
    const parsed = JSON.parse(line) as Partial<SelfTestResult>;
    return {
      ok: parsed.ok === true,
      ...(typeof parsed.account === "string" ? { account: parsed.account } : {}),
      ...(typeof parsed.mode === "string" ? { mode: parsed.mode } : {}),
      ...(typeof parsed.folders === "number" ? { folders: parsed.folders } : {}),
      ...(typeof parsed.unread === "number" ? { unread: parsed.unread } : {}),
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    };
  } catch {
    return { ok: false, error: "unreadable output" };
  }
}

// --------------------------------------------------------------- callbacks

export async function handleAddonsCallback(ctx: Context, deps: AddonsDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(ADDONS_CALLBACK_PREFIX)) return false;

  const userId = ctx.from?.id;
  if (userId === undefined || userId === null) {
    await ctx.answerCallbackQuery({ text: t("addons.not_permitted"), show_alert: true }).catch(() => {});
    return true;
  }

  const isAdmin = isAdminUser(userId);
  const metadata = parseAddonsMetadata(deps.interactionManager.getSnapshot());
  const messageId = getCallbackMessageId(ctx);

  if (!metadata || messageId === null || metadata.messageId !== messageId) {
    await inactive(ctx);
    return true;
  }

  const parts = data.split(":");
  const verb = parts[1] ?? "";

  try {
    if (data === ADDONS_CANCEL) {
      clearInteraction(deps, "addons_closed");
      await cancelMenu(ctx);
      return true;
    }

    if (data === ADDONS_LIST) {
      await ack(ctx);
      await renderList(ctx, deps, messageId, userId, isAdmin);
      return true;
    }

    // ---------------------------------------------------------- read-only actions

    if (verb === "open") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      await ack(ctx);
      await renderDetail(ctx, deps, messageId, addon, userId, isAdmin);
      return true;
    }

    if (verb === "test") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const requested = Number(parts[3]);
      // A standard account may test only its own profile, whatever the callback says.
      const accountId = isAdmin && Number.isInteger(requested) ? requested : userId;
      await ack(ctx);
      const result = await runSelfTest(addon, accountId);
      await ctx.reply(result);
      return true;
    }

    if (verb === "ask") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const name = addon.manifest?.name ?? addon.id;
      const admins = config.telegram.adminUserIds.filter((id) => id !== userId);
      let sent = 0;
      for (const adminId of admins) {
        try {
          await ctx.api.sendMessage(
            adminId,
            t("addons.ask_admin.message", { account: String(userId), name }),
          );
          sent += 1;
        } catch (error) {
          logger.warn(`[Addons] Could not notify admin ${adminId}: ${(error as Error).message}`);
        }
      }
      await ctx
        .answerCallbackQuery({ text: t(sent > 0 ? "addons.ask_admin.sent" : "addons.ask_admin.none") })
        .catch(() => {});
      return true;
    }

    // ---------------------------------------------------------- admin-only actions

    if (!isAdmin) {
      logger.warn(`[Authz] Refused add-on callback for userId=${userId}: ${verb}`);
      await ctx
        .answerCallbackQuery({ text: t("addons.not_permitted"), show_alert: true })
        .catch(() => {});
      return true;
    }

    if (verb === "accounts") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      await ack(ctx);
      await renderAccounts(ctx, deps, messageId, addon);
      return true;
    }

    if (verb === "account") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      if (!Number.isInteger(accountId)) {
        await inactive(ctx);
        return true;
      }
      await ack(ctx);
      await renderAccount(ctx, deps, messageId, addon, accountId);
      return true;
    }

    if (verb === "addaccount") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      await ack(ctx);
      await editMenu(
        ctx,
        messageId,
        `${t("addons.accounts.title", { name: addon.manifest?.name ?? addon.id })}\n\n${t("addons.accounts.add_prompt")}`,
        new InlineKeyboard()
          .text(t("addons.menu.back"), `${ADDONS_ACCOUNTS}:${addon.id}`)
          .text(t("inline.button.cancel"), ADDONS_CANCEL),
      );
      setStage(deps, {
        flow: "addons",
        stage: "await_account_id",
        messageId,
        addonId: addon.id,
      });
      return true;
    }

    if (verb === "profile") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      if (!Number.isInteger(accountId)) {
        await inactive(ctx);
        return true;
      }
      await ack(ctx);
      await renderProfile(ctx, deps, messageId, addon, accountId);
      return true;
    }

    if (verb === "field") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      const key = parts[4] ?? "";
      if (!Number.isInteger(accountId)) {
        await inactive(ctx);
        return true;
      }
      await ack(ctx);
      await renderField(ctx, deps, messageId, addon, accountId, key);
      return true;
    }

    if (verb === "edit") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      const key = parts[4] ?? "";
      const field = fieldOf(addon, key);
      if (!Number.isInteger(accountId) || !field) {
        await inactive(ctx);
        return true;
      }
      if (field.type !== "string" && field.type !== "number" && field.type !== "string[]") {
        await inactive(ctx);
        return true;
      }
      await ack(ctx);
      await editMenu(
        ctx,
        messageId,
        `${buildFieldText(field, key, await currentProfile(addon, accountId))}\n\n${fieldPrompt(field)}`,
        new InlineKeyboard()
          .text(t("addons.menu.back"), `${ADDONS_FIELD}:${addon.id}:${accountId}:${key}`)
          .text(t("inline.button.cancel"), ADDONS_CANCEL),
      );
      setStage(deps, {
        flow: "addons",
        stage: "await_field_value",
        messageId,
        addonId: addon.id,
        accountId,
        fieldKey: key,
      });
      return true;
    }

    if (verb === "set") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      const key = parts[4] ?? "";
      const raw = parts.slice(5).join(":");
      const field = fieldOf(addon, key);
      if (!Number.isInteger(accountId) || !field) {
        await inactive(ctx);
        return true;
      }

      if (addon.id === "mail" && key === "mode" && raw === "mailbox") {
        const profile = await currentProfile(addon, accountId);
        if (profile.mode !== "mailbox") {
          await ack(ctx);
          await renderModeConfirm(ctx, deps, messageId, addon, accountId);
          return true;
        }
      }

      const value = parseFieldInput(field, raw);
      await setProfileField(addon, accountId, key, value);
      await ctx.answerCallbackQuery({ text: t("addons.config.saved") }).catch(() => {});
      await renderField(ctx, deps, messageId, addon, accountId, key);
      return true;
    }

    if (verb === "setconfirm") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      const raw = parts.slice(4).join(":");
      const field = fieldOf(addon, "mode");
      if (!Number.isInteger(accountId) || !field) {
        await inactive(ctx);
        return true;
      }
      const value = parseFieldInput(field, raw);
      await setProfileField(addon, accountId, "mode", value);
      await ctx.answerCallbackQuery({ text: t("addons.config.saved") }).catch(() => {});
      await renderField(ctx, deps, messageId, addon, accountId, "mode");
      return true;
    }

    if (verb === "grant") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      if (!Number.isInteger(accountId)) {
        await inactive(ctx);
        return true;
      }
      const policy = await readAddonPolicy(addon.id);
      const current = grantOf(policy, accountId);
      const next = current === "use" ? "off" : "use";
      await setGrant(addon.id, accountId, next);
      if (next === "use") {
        await ensureAccountProfile(addon, accountId);
      } else {
        // Revocation deletes the profile and credentials together, then restarts the server
        // so no MCP process keeps a credential for an account that just lost access.
        await removeAccountProfile(addon, accountId);
        await restartServer().catch((error) => {
          logger.warn(`[Addons] Restart after revoke failed: ${(error as Error).message}`);
        });
      }
      await ctx
        .answerCallbackQuery({
          text: t(next === "use" ? "addons.grant.use" : "addons.grant.off"),
        })
        .catch(() => {});
      await renderAccount(ctx, deps, messageId, addon, accountId);
      return true;
    }

    if (verb === "secrets") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      if (!Number.isInteger(accountId)) {
        await inactive(ctx);
        return true;
      }
      await ack(ctx);
      await renderSecrets(ctx, deps, messageId, addon, accountId);
      return true;
    }

    if (verb === "secret") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      const key = parts[4] ?? "";
      if (!Number.isInteger(accountId)) {
        await inactive(ctx);
        return true;
      }
      await ack(ctx);
      await renderSecretEntry(ctx, deps, messageId, addon, accountId, key);
      return true;
    }

    if (verb === "secretask") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      const key = parts[4] ?? "";
      const declared = addon.manifest?.secrets?.find((entry) => entry.key === key);
      if (!Number.isInteger(accountId) || !declared) {
        await inactive(ctx);
        return true;
      }
      await ack(ctx);
      await editMenu(
        ctx,
        messageId,
        t("addons.secret.prompt", { label: declared.label ?? key }),
        new InlineKeyboard()
          .text(t("addons.menu.back"), `${ADDONS_SECRET}:${addon.id}:${accountId}:${key}`)
          .text(t("inline.button.cancel"), ADDONS_CANCEL),
      );
      setStage(deps, {
        flow: "addons",
        stage: "await_secret_value",
        messageId,
        addonId: addon.id,
        accountId,
        secretKey: key,
      });
      return true;
    }

    if (verb === "secretdel") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const accountId = Number(parts[3]);
      const key = parts[4] ?? "";
      if (!Number.isInteger(accountId)) {
        await inactive(ctx);
        return true;
      }
      await deleteSecret(addon, accountId, key);
      await ctx
        .answerCallbackQuery({ text: t("addons.secret.deleted", { key }) })
        .catch(() => {});
      await renderSecretEntry(ctx, deps, messageId, addon, accountId, key);
      return true;
    }

    if (verb === "enable") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      if (addon.error || !addon.manifest) {
        await ctx
          .answerCallbackQuery({ text: addon.error ?? t("addons.unhealthy"), show_alert: true })
          .catch(() => {});
        return true;
      }
      await ack(ctx);
      // Every gated agent is widened. Asking which one is a question with a wrong answer
      // that only shows up later as a tool the agent cannot call.
      await renderEnableConfirm(
        ctx,
        deps,
        messageId,
        addon,
        await listPermissionAgents(),
      );
      return true;
    }

    if (verb === "enableconfirm") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const agents = metadata.agents ?? [];
      if (addon.error || !addon.manifest) {
        await ctx
          .answerCallbackQuery({ text: addon.error ?? t("addons.unhealthy"), show_alert: true })
          .catch(() => {});
        return true;
      }
      // The enabling admin is an ordinary account with `use`, so an add-on they turned on
      // works from their own workspace without a second trip through the grant screen.
      if (addon.manifest.scope === "per-user") {
        await setGrant(addon.id, userId, "use");
        await ensureAccountProfile(addon, userId);
      }
      await enableAddon(addon, agents);
      await ctx
        .answerCallbackQuery({ text: t("addons.enable.done", { name: addon.manifest.name }) })
        .catch(() => {});
      await renderDetail(ctx, deps, messageId, addon, userId, true);
      return true;
    }

    if (verb === "disable") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      await ack(ctx);
      await renderDisableConfirm(ctx, deps, messageId, addon);
      return true;
    }

    if (verb === "disableconfirm") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      await disableAddon(addon);
      await ctx
        .answerCallbackQuery({
          text: t("addons.disable.done", { name: addon.manifest?.name ?? addon.id }),
        })
        .catch(() => {});
      await renderDetail(ctx, deps, messageId, addon, userId, true);
      return true;
    }

    if (verb === "default") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      const policy = await readAddonPolicy(addon.id);
      if (addon.manifest?.scope === "per-user" && policy.default === "admin-only") {
        // `all-users` on a per-user add-on gives every allowed account a slot with no
        // credential; make it a deliberate second press rather than one tap.
        await ack(ctx);
        await renderDefaultConfirm(ctx, deps, messageId, addon);
        return true;
      }
      const next = policy.default === "all-users" ? "admin-only" : "all-users";
      await setDefaultPolicy(addon.id, next);
      await ctx
        .answerCallbackQuery({
          text: t(next === "all-users" ? "addons.default.all_users" : "addons.default.admin_only"),
        })
        .catch(() => {});
      await renderDetail(ctx, deps, messageId, addon, userId, true);
      return true;
    }

    if (verb === "defaultconfirm") {
      const addon = await loadAddon(ctx, parts[2] ?? "");
      if (!addon) return true;
      await setDefaultPolicy(addon.id, "all-users");
      await ctx
        .answerCallbackQuery({ text: t("addons.default.all_users") })
        .catch(() => {});
      await renderDetail(ctx, deps, messageId, addon, userId, true);
      return true;
    }

    await ctx.answerCallbackQuery({ text: t("callback.unknown_command") }).catch(() => {});
    return true;
  } catch (error) {
    logger.error("[Addons] Error handling add-on callback:", error);
    const message =
      error instanceof AddonConfigError
        ? t("addons.config.invalid", {
            field: error.field ?? "config",
            reason: error.reason,
          })
        : t("callback.processing_error");
    await ctx
      .answerCallbackQuery({ text: message.slice(0, 190), show_alert: true })
      .catch(() => {});
    return true;
  }
}

// --------------------------------------------------------------- text answers

async function currentProfile(
  addon: InstalledAddon,
  accountId: number,
): Promise<AddonProfile> {
  return readProfile(addon, accountId)
    .then((result) => result.profile)
    .catch(async () => defaultProfile(addon));
}

function fieldPrompt(field: AddonConfigField): string {
  switch (field.type) {
    case "number":
      return `Send a number${field.min !== undefined ? ` from ${field.min}` : ""}${
        field.max !== undefined ? ` to ${field.max}` : ""
      }.`;
    case "string[]":
      return "Send a comma-separated list. Empty removes every entry.";
    default:
      return "Send the new value.";
  }
}

async function deleteSecretMessage(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn(`[Addons] Could not delete the credential message: ${(error as Error).message}`);
  }
}

/**
 * Consumes the next plain text message as an add-on answer.
 *
 * Returns true when the message belonged to this flow, so it is never forwarded to the agent
 * as a prompt. A rejected value keeps the step open: the admin is typing configuration, not
 * a credential, and making them reopen the screen for a typo is worse than one retry.
 */
export async function handleAddonsTextInput(ctx: Context, deps: AddonsDeps): Promise<boolean> {
  const text = ctx.message?.text;
  if (text === undefined || text.startsWith("/")) return false;

  const metadata = parseAddonsMetadata(deps.interactionManager.getSnapshot());
  if (!metadata || !TEXT_STAGES.includes(metadata.stage)) return false;

  const userId = ctx.from?.id;
  if (userId === undefined || userId === null || !isAdminUser(userId)) {
    clearInteraction(deps, "addons_not_permitted");
    await ctx.reply(t("addons.not_permitted"));
    return true;
  }

  const addon = metadata.addonId ? await getInstalledAddon(metadata.addonId) : null;
  if (!addon) {
    clearInteraction(deps, "addons_addon_missing");
    await ctx.reply(t("inline.inactive_callback"));
    return true;
  }

  const trimmed = text.trim();

  try {
    if (metadata.stage === "await_account_id") {
      if (!/^\d{5,20}$/.test(trimmed)) {
        await ctx.reply(t("addons.accounts.id_invalid"));
        return true;
      }
      const accountId = Number(trimmed);
      await setGrant(addon.id, accountId, "use");
      await ensureAccountProfile(addon, accountId);
      await ctx.reply(t("addons.accounts.added", { id: String(accountId) }));
      await renderAccount(ctx, deps, metadata.messageId, addon, accountId);
      return true;
    }

    if (metadata.stage === "await_field_value") {
      const accountId = metadata.accountId;
      const key = metadata.fieldKey;
      const field = key ? fieldOf(addon, key) : null;
      if (accountId === undefined || !key || !field) {
        clearInteraction(deps, "addons_field_missing");
        return true;
      }

      const value = parseFieldInput(field, text);
      await setProfileField(addon, accountId, key, value);
      await ctx.reply(t("addons.config.saved"));
      await renderField(ctx, deps, metadata.messageId, addon, accountId, key);
      return true;
    }

    // await_secret_value
    const accountId = metadata.accountId;
    const key = metadata.secretKey;
    if (accountId === undefined || !key) {
      clearInteraction(deps, "addons_secret_missing");
      return true;
    }
    if (!trimmed) {
      await ctx.reply(t("addons.value_empty"));
      return true;
    }

    await setSecret(addon, accountId, key, trimmed);
    await deleteSecretMessage(ctx);
    await ctx.reply(t("addons.secret.saved", { key }));
    await renderSecrets(ctx, deps, metadata.messageId, addon, accountId);
    return true;
  } catch (error) {
    logger.error("[Addons] Error handling add-on text input:", error);

    if (error instanceof AddonConfigError) {
      await ctx.reply(
        t("addons.config.invalid", {
          field: error.field ?? metadata.fieldKey ?? metadata.secretKey ?? "value",
          reason: error.reason,
        }),
      );
      return true;
    }

    clearInteraction(deps, "addons_text_error");
    if (metadata.stage === "await_secret_value") {
      await deleteSecretMessage(ctx);
    }
    await ctx.reply(
      t("addons.error.upstream", { reason: (error as Error).message?.slice(0, 190) ?? "unknown" }),
    );
    return true;
  }
}
