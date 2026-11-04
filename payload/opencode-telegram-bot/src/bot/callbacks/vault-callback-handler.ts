import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { InlineKeyboard, type Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { isPrimaryAdmin } from "../../app/services/access-control.js";
import {
  addSecret,
  countSecrets,
  deleteSecret,
  deriveEnvName,
  getSecretSummary,
  listSecretSummaries,
  SecretStoreError,
  updateSecretValue,
} from "../../app/services/secret-store-service.js";
import {
  connectProviderKey,
  disconnectProvider,
  getIntegration,
  listIntegrations,
  PROVIDER_SHORTLIST,
  searchIntegrations,
  summarizeConnection,
  type ProviderIntegration,
} from "../../app/services/provider-integration-service.js";
import { config } from "../../config.js";
import { getCurrentSession } from "../../app/stores/settings-store.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { cancelMenu } from "./feedback.js";
import {
  buildVaultEnvDeleteKeyboard,
  buildVaultEnvDetailKeyboard,
  buildVaultEnvListKeyboard,
  buildVaultMainKeyboard,
  buildVaultProviderDetailKeyboard,
  buildVaultProviderListKeyboard,
  buildVaultProviderPageKeyboard,
  buildVaultProviderSearchResultsKeyboard,
  formatVaultEnvDetailText,
  formatVaultEnvListText,
  formatVaultMainText,
  formatVaultProviderDetailText,
  formatVaultProviderListText,
  formatVaultProviderPageText,
  formatVaultProviderSearchEmptyText,
  formatVaultProviderSearchResultsText,
  parseCallbackArgument,
  parseProviderPage,
  providerPageCount,
  sliceProviderPage,
  VAULT_CALLBACK_PREFIX,
  VAULT_CLOSE_CALLBACK,
  VAULT_ENV_ADD_CALLBACK,
  VAULT_ENV_DELETE_CONFIRM_PREFIX,
  VAULT_ENV_DELETE_PREFIX,
  VAULT_ENV_LIST_CALLBACK,
  VAULT_ENV_OPEN_PREFIX,
  VAULT_ENV_SET_PREFIX,
  VAULT_MAIN_CALLBACK,
  VAULT_PROVIDER_DISCONNECT_PREFIX,
  VAULT_PROVIDER_KEY_PREFIX,
  VAULT_PROVIDER_LIST_CALLBACK,
  VAULT_PROVIDER_OPEN_PREFIX,
  VAULT_PROVIDER_SEARCH_CALLBACK,
  VAULT_RESTART_CALLBACK,
} from "../menus/vault-menu.js";

/**
 * Vault callbacks and the text answers they wait for.
 *
 * Two rules run through the whole file:
 *
 * 1. The menu is primary-admin only. The command router hides it and refuses it for other
 *    accounts, but a callback or a text message arrives on a separate path, so the check is
 *    repeated here rather than assumed from the entry point.
 * 2. A value typed by the operator is deleted from the chat and never echoed. The bot's
 *    replies only ever contain the derived env name and a mask.
 */

const execFileAsync = promisify(execFile);

type VaultStage =
  | "main"
  | "env_list"
  | "env_detail"
  | "env_delete_confirm"
  | "env_await_label"
  | "env_await_value"
  | "env_await_edit_value"
  | "provider_list"
  | "provider_search"
  | "provider_results"
  | "provider_detail"
  | "provider_await_key";

const VALID_STAGES: readonly VaultStage[] = [
  "main",
  "env_list",
  "env_detail",
  "env_delete_confirm",
  "env_await_label",
  "env_await_value",
  "env_await_edit_value",
  "provider_list",
  "provider_search",
  "provider_results",
  "provider_detail",
  "provider_await_key",
];

/** Stages where a typed answer is the expected input. */
const TEXT_STAGES: readonly VaultStage[] = [
  "env_await_label",
  "env_await_value",
  "env_await_edit_value",
  "provider_search",
  "provider_await_key",
];

interface VaultMetadata {
  flow: "vault";
  stage: VaultStage;
  messageId: number;
  page?: number;
  query?: string;
  targetId?: string;
  /** Label captured in the first step of "add secret", carried into the value step. */
  pendingLabel?: string;
}

export type VaultDeps = Pick<
  AppContainer,
  "interactionManager" | "foregroundSessionState" | "attachManager"
>;

export function parseVaultMetadata(state: unknown): VaultMetadata | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const snapshot = state as { kind?: string; metadata?: Record<string, unknown> };
  if (snapshot.kind !== "custom" || !snapshot.metadata) {
    return null;
  }

  const metadata = snapshot.metadata;
  if (metadata.flow !== "vault" || typeof metadata.stage !== "string") {
    return null;
  }
  const stage = metadata.stage as VaultStage;
  if (!VALID_STAGES.includes(stage)) {
    return null;
  }
  if (typeof metadata.messageId !== "number") {
    return null;
  }

  const parsed: VaultMetadata = { flow: "vault", stage, messageId: metadata.messageId };
  if (typeof metadata.page === "number" && Number.isInteger(metadata.page)) {
    parsed.page = metadata.page;
  }
  if (typeof metadata.query === "string") {
    parsed.query = metadata.query;
  }
  if (typeof metadata.targetId === "string") {
    parsed.targetId = metadata.targetId;
  }
  if (typeof metadata.pendingLabel === "string") {
    parsed.pendingLabel = metadata.pendingLabel;
  }
  return parsed;
}

function getCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }
  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function clearVaultInteraction(deps: VaultDeps, reason: string): void {
  if (parseVaultMetadata(deps.interactionManager.getSnapshot())) {
    deps.interactionManager.clear(reason);
  }
}

function setStage(deps: VaultDeps, metadata: VaultMetadata): void {
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
  if (!ctx.chat) {
    return;
  }
  await ctx.api.editMessageText(ctx.chat.id, messageId, text, { reply_markup: keyboard });
}

/** Answer the callback without a toast; the edited message carries the feedback. */
async function ack(ctx: Context): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
}

// --------------------------------------------------------------- environment secrets

async function providerConnectionCount(): Promise<number> {
  try {
    const integrations = await listIntegrations();
    return integrations.filter((integration) => summarizeConnection(integration).connected).length;
  } catch (error) {
    // The main menu has to open even when the OpenCode server is down.
    logger.warn(`[Vault] Could not count provider connections: ${(error as Error).message}`);
    return 0;
  }
}

async function renderMain(ctx: Context, deps: VaultDeps, messageId: number): Promise<void> {
  const envCount = await countSecrets().catch(() => 0);
  const providerCount = await providerConnectionCount();
  const next: VaultMetadata = { flow: "vault", stage: "main", messageId };

  await editMenu(ctx, messageId, formatVaultMainText(envCount, providerCount), buildVaultMainKeyboard(envCount));
  setStage(deps, next);
}

async function renderEnvList(ctx: Context, deps: VaultDeps, messageId: number): Promise<void> {
  const entries = await listSecretSummaries();
  const next: VaultMetadata = { flow: "vault", stage: "env_list", messageId };

  await editMenu(ctx, messageId, formatVaultEnvListText(entries), buildVaultEnvListKeyboard(entries));
  setStage(deps, next);
}

async function renderEnvDetail(
  ctx: Context,
  deps: VaultDeps,
  messageId: number,
  id: string,
): Promise<void> {
  const entry = await getSecretSummary(id);
  if (!entry) {
    await ctx
      .answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true })
      .catch(() => {});
    await renderEnvList(ctx, deps, messageId);
    return;
  }

  await editMenu(ctx, messageId, formatVaultEnvDetailText(entry), buildVaultEnvDetailKeyboard(entry.id));
  setStage(deps, { flow: "vault", stage: "env_detail", messageId, targetId: entry.id });
}

/** Cancel from a text step returns to the screen the step was opened from. */
function cancelKeyboard(target: string): InlineKeyboard {
  return new InlineKeyboard().text(t("inline.button.cancel"), target);
}

async function renderProviderList(
  ctx: Context,
  deps: VaultDeps,
  messageId: number,
): Promise<void> {
  const integrations = await listIntegrations();
  const byId = new Map(integrations.map((integration) => [integration.id, integration]));
  const shortlist = PROVIDER_SHORTLIST.map((id) => byId.get(id)).filter(
    (integration): integration is ProviderIntegration => integration !== undefined,
  );

  await editMenu(
    ctx,
    messageId,
    formatVaultProviderListText(),
    buildVaultProviderListKeyboard(shortlist),
  );
  setStage(deps, { flow: "vault", stage: "provider_list", messageId });
}

async function renderProviderPage(
  ctx: Context,
  deps: VaultDeps,
  messageId: number,
  page: number,
): Promise<void> {
  const integrations = await listIntegrations();
  const pages = providerPageCount(integrations.length);
  const safePage = Math.min(Math.max(page, 1), pages);
  const pageItems = sliceProviderPage(integrations, safePage);

  await editMenu(
    ctx,
    messageId,
    formatVaultProviderPageText(safePage, pages, integrations.length),
    buildVaultProviderPageKeyboard(pageItems, safePage, pages),
  );
  setStage(deps, { flow: "vault", stage: "provider_results", messageId, page: safePage });
}

async function renderProviderDetail(
  ctx: Context,
  deps: VaultDeps,
  messageId: number,
  providerId: string,
): Promise<void> {
  const integration = await getIntegration(providerId);
  if (!integration) {
    await ack(ctx);
    await renderProviderList(ctx, deps, messageId);
    return;
  }

  await editMenu(
    ctx,
    messageId,
    formatVaultProviderDetailText(integration),
    buildVaultProviderDetailKeyboard(integration),
  );
  setStage(deps, { flow: "vault", stage: "provider_detail", messageId, targetId: integration.id });
}

// --------------------------------------------------------------- restart

/**
 * Apply the env file by restarting the server.
 *
 * The env file is read by systemd at service start, so a new variable cannot reach the agent
 * without a restart. Refused while this account has a running session: killing the server
 * mid-turn loses the answer the operator is waiting for, and the file is already written.
 */
async function restartServer(ctx: Context, deps: VaultDeps, messageId: number): Promise<void> {
  const busy =
    deps.foregroundSessionState.isSessionBusy(getCurrentSession()?.id) || deps.attachManager.isBusy();
  if (busy) {
    await ctx.answerCallbackQuery({ text: t("vault.restart.busy"), show_alert: true }).catch(() => {});
    return;
  }

  const env = { ...process.env };
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") {
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }

  try {
    await execFileAsync("systemctl", ["--user", "restart", config.vault.serverUnit], {
      timeout: 20_000,
      env,
    });
    logger.info(`[Vault] Restarted ${config.vault.serverUnit} to apply env secrets`);
    await ctx.answerCallbackQuery({ text: t("vault.restart.running") }).catch(() => {});
  } catch (error) {
    logger.error(`[Vault] Failed to restart ${config.vault.serverUnit}:`, error);
    await ctx.answerCallbackQuery({ text: t("vault.restart.failed"), show_alert: true }).catch(() => {});
  }

  await renderEnvList(ctx, deps, messageId).catch((error) => {
    logger.error("[Vault] Could not refresh the env list after restart:", error);
  });
}

// --------------------------------------------------------------- callbacks

export async function handleVaultCallback(ctx: Context, deps: VaultDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(VAULT_CALLBACK_PREFIX)) {
    return false;
  }

  if (!isPrimaryAdmin(ctx.from?.id)) {
    logger.warn(`[Authz] Refused vault callback for userId=${ctx.from?.id}`);
    await ctx
      .answerCallbackQuery({ text: t("vault.not_permitted"), show_alert: true })
      .catch(() => {});
    return true;
  }

  const metadata = parseVaultMetadata(deps.interactionManager.getSnapshot());
  const messageId = getCallbackMessageId(ctx);

  if (!metadata || messageId === null || metadata.messageId !== messageId) {
    await ctx
      .answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true })
      .catch(() => {});
    return true;
  }

  try {
    if (data === VAULT_CLOSE_CALLBACK) {
      clearVaultInteraction(deps, "vault_closed");
      await cancelMenu(ctx);
      return true;
    }

    if (data === VAULT_MAIN_CALLBACK) {
      await ack(ctx);
      await renderMain(ctx, deps, messageId);
      return true;
    }

    if (data === VAULT_ENV_LIST_CALLBACK) {
      await ack(ctx);
      await renderEnvList(ctx, deps, messageId);
      return true;
    }

    if (data === VAULT_ENV_ADD_CALLBACK) {
      await ack(ctx);
      await editMenu(ctx, messageId, t("vault.env.ask_label"), cancelKeyboard(VAULT_ENV_LIST_CALLBACK));
      setStage(deps, { flow: "vault", stage: "env_await_label", messageId });
      return true;
    }

    const openId = parseCallbackArgument(data, VAULT_ENV_OPEN_PREFIX);
    if (openId) {
      await ack(ctx);
      await renderEnvDetail(ctx, deps, messageId, openId);
      return true;
    }

    const setValueId = parseCallbackArgument(data, VAULT_ENV_SET_PREFIX);
    if (setValueId) {
      const entry = await getSecretSummary(setValueId);
      if (!entry) {
        await ack(ctx);
        await renderEnvList(ctx, deps, messageId);
        return true;
      }
      await ack(ctx);
      await editMenu(
        ctx,
        messageId,
        t("vault.env.ask_value", { name: entry.name }),
        cancelKeyboard(VAULT_ENV_LIST_CALLBACK),
      );
      setStage(deps, {
        flow: "vault",
        stage: "env_await_edit_value",
        messageId,
        targetId: entry.id,
      });
      return true;
    }

    const deleteId = parseCallbackArgument(data, VAULT_ENV_DELETE_PREFIX);
    if (deleteId) {
      const entry = await getSecretSummary(deleteId);
      if (!entry) {
        await ack(ctx);
        await renderEnvList(ctx, deps, messageId);
        return true;
      }
      await ack(ctx);
      await editMenu(
        ctx,
        messageId,
        t("vault.env.delete_confirm", { label: entry.label, name: entry.name }),
        buildVaultEnvDeleteKeyboard(entry.id),
      );
      setStage(deps, { flow: "vault", stage: "env_delete_confirm", messageId, targetId: entry.id });
      return true;
    }

    const deleteConfirmId = parseCallbackArgument(data, VAULT_ENV_DELETE_CONFIRM_PREFIX);
    if (deleteConfirmId) {
      const entry = await getSecretSummary(deleteConfirmId);
      const removed = await deleteSecret(deleteConfirmId);
      await ctx
        .answerCallbackQuery({
          text: removed
            ? t("vault.env.deleted", { name: entry?.name ?? deleteConfirmId })
            : t("inline.inactive_callback"),
        })
        .catch(() => {});
      await renderEnvList(ctx, deps, messageId);
      return true;
    }

    if (data === VAULT_PROVIDER_LIST_CALLBACK) {
      await ack(ctx);
      await renderProviderList(ctx, deps, messageId);
      return true;
    }

    if (data === VAULT_PROVIDER_SEARCH_CALLBACK) {
      await ack(ctx);
      await editMenu(
        ctx,
        messageId,
        t("vault.provider.search_ask"),
        cancelKeyboard(VAULT_PROVIDER_LIST_CALLBACK),
      );
      setStage(deps, { flow: "vault", stage: "provider_search", messageId });
      return true;
    }

    const page = parseProviderPage(data);
    if (page !== null) {
      await ack(ctx);
      await renderProviderPage(ctx, deps, messageId, page);
      return true;
    }

    const providerId = parseCallbackArgument(data, VAULT_PROVIDER_OPEN_PREFIX);
    if (providerId) {
      await ack(ctx);
      await renderProviderDetail(ctx, deps, messageId, providerId);
      return true;
    }

    const keyProviderId = parseCallbackArgument(data, VAULT_PROVIDER_KEY_PREFIX);
    if (keyProviderId) {
      const integration = await getIntegration(keyProviderId);
      if (!integration) {
        await ack(ctx);
        await renderProviderList(ctx, deps, messageId);
        return true;
      }
      await ack(ctx);
      await editMenu(
        ctx,
        messageId,
        t("vault.provider.ask_key", { name: integration.name }),
        cancelKeyboard(`${VAULT_PROVIDER_OPEN_PREFIX}${integration.id}`),
      );
      setStage(deps, {
        flow: "vault",
        stage: "provider_await_key",
        messageId,
        targetId: integration.id,
      });
      return true;
    }

    const disconnectProviderId = parseCallbackArgument(data, VAULT_PROVIDER_DISCONNECT_PREFIX);
    if (disconnectProviderId) {
      const integration = await getIntegration(disconnectProviderId);
      const summary = integration ? summarizeConnection(integration) : { connected: false };
      if (!summary.credentialId) {
        // An env connection is not a stored credential, so there is nothing to delete here.
        await ctx
          .answerCallbackQuery({ text: t("vault.provider.disconnect_env_only"), show_alert: true })
          .catch(() => {});
        return true;
      }

      await disconnectProvider(summary.credentialId);
      await ctx
        .answerCallbackQuery({ text: t("vault.provider.disconnected", { name: integration?.name ?? disconnectProviderId }) })
        .catch(() => {});
      await renderProviderDetail(ctx, deps, messageId, disconnectProviderId);
      return true;
    }

    if (data === VAULT_RESTART_CALLBACK) {
      await restartServer(ctx, deps, messageId);
      return true;
    }

    await ctx.answerCallbackQuery({ text: t("callback.unknown_command") }).catch(() => {});
    return true;
  } catch (error) {
    logger.error("[Vault] Error handling vault callback:", error);
    const message =
      error instanceof SecretStoreError ? error.message : t("callback.processing_error");
    await ctx.answerCallbackQuery({ text: message.slice(0, 190), show_alert: true }).catch(() => {});
    return true;
  }
}

// --------------------------------------------------------------- text answers

async function deleteSecretMessage(ctx: Context): Promise<void> {
  // A secret must not stay in the chat history, and Telegram keeps it even when the bot's
  // reply is edited. Failure is logged rather than surfaced: the value is already stored.
  try {
    await ctx.deleteMessage();
  } catch (error) {
    logger.warn(`[Vault] Could not delete the secret message: ${(error as Error).message}`);
  }
}

/**
 * Consumes the next plain text message as a vault answer.
 *
 * Returns true when the message belonged to the vault flow, so the router stops before the
 * text can be sent to the agent as a prompt.
 */
export async function handleVaultTextInput(ctx: Context, deps: VaultDeps): Promise<boolean> {
  const text = ctx.message?.text;
  if (text === undefined || text.startsWith("/")) {
    return false;
  }

  const metadata = parseVaultMetadata(deps.interactionManager.getSnapshot());
  if (!metadata || !TEXT_STAGES.includes(metadata.stage)) {
    return false;
  }

  if (!isPrimaryAdmin(ctx.from?.id)) {
    // Never let a refused answer fall through to the agent as a prompt.
    clearVaultInteraction(deps, "vault_not_permitted");
    await ctx.reply(t("vault.not_permitted"));
    return true;
  }

  const trimmed = text.trim();

  try {
    if (metadata.stage === "env_await_label") {
      if (!trimmed) {
        await ctx.reply(t("vault.env.label_invalid"));
        return true;
      }

      // The env name is derived here so the operator sees it before typing the value. It is
      // only provisional: a collision gets a suffix when the entry is actually created.
      const preview = deriveEnvName(trimmed);
      if (!preview) {
        await ctx.reply(t("vault.env.label_invalid"));
        return true;
      }

      await editMenu(
        ctx,
        metadata.messageId,
        t("vault.env.ask_value", { name: preview }),
        cancelKeyboard(VAULT_ENV_LIST_CALLBACK),
      );
      setStage(deps, {
        flow: "vault",
        stage: "env_await_value",
        messageId: metadata.messageId,
        pendingLabel: trimmed,
      });
      return true;
    }

    if (metadata.stage === "env_await_value") {
      if (!trimmed) {
        await ctx.reply(t("vault.value_empty"));
        return true;
      }
      const label = metadata.pendingLabel;
      if (!label) {
        clearVaultInteraction(deps, "vault_missing_label");
        await ctx.reply(t("vault.env.label_invalid"));
        return true;
      }

      const entry = await addSecret({ label, value: trimmed });
      await deleteSecretMessage(ctx);
      await ctx.reply(t("vault.env.saved", { name: entry.name }));
      await renderEnvList(ctx, deps, metadata.messageId);
      return true;
    }

    if (metadata.stage === "env_await_edit_value") {
      if (!trimmed) {
        await ctx.reply(t("vault.value_empty"));
        return true;
      }
      const targetId = metadata.targetId;
      if (!targetId) {
        clearVaultInteraction(deps, "vault_missing_target");
        return true;
      }

      const entry = await updateSecretValue(targetId, trimmed);
      if (!entry) {
        clearVaultInteraction(deps, "vault_target_missing");
        await renderEnvList(ctx, deps, metadata.messageId);
        return true;
      }

      await deleteSecretMessage(ctx);
      await ctx.reply(t("vault.env.saved", { name: entry.name }));
      await renderEnvDetail(ctx, deps, metadata.messageId, entry.id);
      return true;
    }

    if (metadata.stage === "provider_search") {
      if (!trimmed) {
        await ctx.reply(t("vault.value_empty"));
        return true;
      }

      const integrations = await listIntegrations();
      const results = searchIntegrations(integrations, trimmed);

      if (results.length === 0) {
        await editMenu(
          ctx,
          metadata.messageId,
          formatVaultProviderSearchEmptyText(trimmed),
          buildVaultProviderSearchResultsKeyboard([]),
        );
      } else {
        await editMenu(
          ctx,
          metadata.messageId,
          formatVaultProviderSearchResultsText(trimmed, results),
          buildVaultProviderSearchResultsKeyboard(results),
        );
      }

      setStage(deps, {
        flow: "vault",
        stage: "provider_results",
        messageId: metadata.messageId,
        query: trimmed,
      });
      return true;
    }

    // provider_await_key
    if (!trimmed) {
      await ctx.reply(t("vault.value_empty"));
      return true;
    }
    const providerId = metadata.targetId;
    if (!providerId) {
      clearVaultInteraction(deps, "vault_missing_provider");
      return true;
    }

    const integration = await getIntegration(providerId);
    if (!integration) {
      clearVaultInteraction(deps, "vault_provider_missing");
      await renderProviderList(ctx, deps, metadata.messageId);
      return true;
    }

    await connectProviderKey(providerId, trimmed, "Telegram vault");
    await deleteSecretMessage(ctx);
    await ctx.reply(t("vault.provider.connected", { name: integration.name }));
    await renderProviderDetail(ctx, deps, metadata.messageId, providerId);
    return true;
  } catch (error) {
    logger.error("[Vault] Error handling vault text input:", error);

    // The value has been consumed either way; keeping the flow open would leave the next
    // message to be read as part of a step that already failed.
    clearVaultInteraction(deps, "vault_text_error");
    await deleteSecretMessage(ctx);

    if (error instanceof SecretStoreError) {
      await ctx.reply(error.message);
      return true;
    }

    const reason = (error as Error).message?.slice(0, 190);
    await ctx.reply(
      metadata.stage === "provider_await_key" && reason
        ? t("vault.provider.connect_failed", { error: reason })
        : t("vault.error", { error: reason ?? "unknown" }),
    );
    return true;
  }
}

/** Exported for the command, which opens the same menu from a fresh message. */
export async function showVaultMenu(ctx: Context, deps: VaultDeps): Promise<void> {
  if (!isPrimaryAdmin(ctx.from?.id)) {
    logger.warn(`[Authz] Refused vault menu for userId=${ctx.from?.id}`);
    await ctx.reply(t("vault.not_permitted"));
    return;
  }

  const envCount = await countSecrets().catch(() => 0);
  const providerCount = await providerConnectionCount();

  const message = await ctx.reply(formatVaultMainText(envCount, providerCount), {
    reply_markup: buildVaultMainKeyboard(envCount),
  });

  deps.interactionManager.start({
    kind: "custom",
    expectedInput: "callback",
    metadata: { flow: "vault", stage: "main", messageId: message.message_id },
  });
}
