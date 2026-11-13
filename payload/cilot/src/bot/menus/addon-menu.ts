import { InlineKeyboard } from "grammy";
import type {
  AddonConfigField,
  AddonManifest,
  InstalledAddon,
} from "../../app/services/addon-manifest-service.js";
import type { AddonGrant } from "../../app/services/addon-policy-service.js";
import type { AddonProfile } from "../../app/services/addon-config-service.js";
import type { SecretStatus } from "../../app/services/addon-secret-service.js";
import { t } from "../../i18n/index.js";

/**
 * Callback vocabulary and the screens built from it.
 *
 * Every callback stays under Telegram's 64-byte limit: the prefix is `addon:`, the add-on id
 * is at most 24 characters, a Telegram id is 10, and a field or key name is short.
 */

export const ADDONS_CALLBACK_PREFIX = "addon:";
export const ADDONS_LIST = `${ADDONS_CALLBACK_PREFIX}list`;
export const ADDONS_CANCEL = `${ADDONS_CALLBACK_PREFIX}cancel`;
export const ADDONS_OPEN = `${ADDONS_CALLBACK_PREFIX}open`;
export const ADDONS_ACCOUNTS = `${ADDONS_CALLBACK_PREFIX}accounts`;
export const ADDONS_ACCOUNT = `${ADDONS_CALLBACK_PREFIX}account`;
export const ADDONS_GRANT = `${ADDONS_CALLBACK_PREFIX}grant`;
export const ADDONS_ADD_ACCOUNT = `${ADDONS_CALLBACK_PREFIX}addaccount`;
export const ADDONS_PROFILE = `${ADDONS_CALLBACK_PREFIX}profile`;
export const ADDONS_FIELD = `${ADDONS_CALLBACK_PREFIX}field`;
export const ADDONS_SET = `${ADDONS_CALLBACK_PREFIX}set`;
export const ADDONS_EDIT = `${ADDONS_CALLBACK_PREFIX}edit`;
export const ADDONS_SECRETS = `${ADDONS_CALLBACK_PREFIX}secrets`;
export const ADDONS_SECRET = `${ADDONS_CALLBACK_PREFIX}secret`;
export const ADDONS_ENABLE = `${ADDONS_CALLBACK_PREFIX}enable`;
export const ADDONS_ENABLE_AGENT = `${ADDONS_CALLBACK_PREFIX}enableagent`;
export const ADDONS_ENABLE_CONFIRM = `${ADDONS_CALLBACK_PREFIX}enableconfirm`;
export const ADDONS_DISABLE = `${ADDONS_CALLBACK_PREFIX}disable`;
export const ADDONS_DISABLE_CONFIRM = `${ADDONS_CALLBACK_PREFIX}disableconfirm`;
export const ADDONS_TEST = `${ADDONS_CALLBACK_PREFIX}test`;
export const ADDONS_DEFAULT = `${ADDONS_CALLBACK_PREFIX}default`;
export const ADDONS_DEFAULT_CONFIRM = `${ADDONS_CALLBACK_PREFIX}defaultconfirm`;
export const ADDONS_SET_CONFIRM = `${ADDONS_CALLBACK_PREFIX}setconfirm`;
export const ADDONS_SECRET_ASK = `${ADDONS_CALLBACK_PREFIX}secretask`;
export const ADDONS_SECRET_DELETE = `${ADDONS_CALLBACK_PREFIX}secretdel`;
export const ADDONS_ASK = `${ADDONS_CALLBACK_PREFIX}ask`;

export interface AddonListItem {
  addon: InstalledAddon;
  enabled: boolean;
  grant: AddonGrant;
  summary: string;
}

export interface AccountRow {
  accountId: number;
  grant: AddonGrant;
  configured: boolean;
}

const GRANT_EMOJI: Record<AddonGrant, string> = { use: "✅", off: "⛔" };

function stateLabel(addon: InstalledAddon, enabled: boolean): string {
  if (addon.error) return t("addons.unhealthy");
  return enabled ? t("addons.enabled") : t("addons.disabled");
}

function scopeLabel(manifest: AddonManifest | null): string {
  return manifest?.scope === "global" ? t("addons.scope.global") : t("addons.scope.per_user");
}

function fieldValue(profile: AddonProfile, key: string): string {
  const value = profile[key];
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : t("addons.value.none");
  if (value === undefined || value === null || value === "") return t("addons.value.not_set");
  return String(value);
}

export function buildAddonsListText(items: AddonListItem[], isAdmin: boolean): string {
  const lines = [t("addons.title"), ""];
  for (const item of items) {
    const state = item.enabled ? "" : ` (${t("addons.disabled")})`;
    lines.push(
      `${item.grant === "use" || isAdmin ? "✅" : "⛔"} ` +
        t("addons.list.line", {
          name: item.addon.manifest?.name ?? item.addon.id,
          scope: scopeLabel(item.addon.manifest),
          summary: `${item.summary}${state}`.trim(),
        }),
    );
  }
  lines.push("");
  lines.push(t(isAdmin ? "addons.list.admin_hint" : "addons.list.user_hint"));
  return lines.join("\n");
}

export function buildAddonsListKeyboard(items: AddonListItem[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    const label = `${item.grant === "use" ? "✅" : "⛔"} ${item.addon.manifest?.name ?? item.addon.id}`;
    keyboard.text(label.slice(0, 64), `${ADDONS_OPEN}:${item.addon.id}`).row();
  }
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildDetailText(options: {
  addon: InstalledAddon;
  enabled: boolean;
  granted: number;
  total: number;
  policyDefault: string;
  profileSummary: string;
  credentialsSet: boolean;
  isAdmin: boolean;
}): string {
  const { addon, enabled } = options;
  const name = addon.manifest?.name ?? addon.id;
  const perUser = addon.manifest?.scope === "per-user";
  const lines = [t("addons.detail.header", { name, state: stateLabel(addon, enabled) })];
  lines.push(
    perUser
      ? `${scopeLabel(addon.manifest)} · ${t("addons.detail.accounts", {
          granted: options.granted,
          total: options.total,
        })}`
      : scopeLabel(addon.manifest),
  );
  if (addon.error) lines.push(`⚠️ ${addon.error}`);

  if (perUser) {
    lines.push(
      t("addons.detail.default_policy", {
        value: t(
          options.policyDefault === "all-users"
            ? "addons.default.all_users"
            : "addons.default.admin_only",
        ),
      }),
    );
  }

  if (options.isAdmin) {
    lines.push("");
    lines.push(`${t("addons.menu.profile")}: ${options.profileSummary}`);
  } else {
    lines.push("");
    lines.push(options.profileSummary);
    lines.push(
      t("addons.profile.credentials", {
        state: t(options.credentialsSet ? "addons.secret.set" : "addons.secret.unset"),
      }),
    );
    lines.push("");
    lines.push(t("addons.profile.read_only"));
  }
  return lines.join("\n");
}

export function buildDetailKeyboard(options: {
  addon: InstalledAddon;
  enabled: boolean;
  accountId: number;
  isAdmin: boolean;
}): InlineKeyboard {
  const { addon, enabled, accountId, isAdmin } = options;
  const keyboard = new InlineKeyboard();

  if (isAdmin) {
    if (addon.manifest?.scope === "per-user") {
      keyboard.text(t("addons.detail.my_profile"), `${ADDONS_PROFILE}:${addon.id}:${accountId}`);
      keyboard.text(t("addons.menu.accounts"), `${ADDONS_ACCOUNTS}:${addon.id}`).row();
    }
    keyboard.text(t("addons.detail.secrets"), `${ADDONS_SECRETS}:${addon.id}:${accountId}`);
    keyboard.text(t("addons.detail.test"), `${ADDONS_TEST}:${addon.id}:${accountId}`).row();
    if (addon.manifest?.scope === "per-user") {
      keyboard
        .text(
          t("addons.detail.default_policy"),
          `${ADDONS_DEFAULT}:${addon.id}`,
        )
        .row();
    }
    keyboard
      .text(
        enabled ? t("addons.detail.disable") : t("addons.detail.enable"),
        `${enabled ? ADDONS_DISABLE : ADDONS_ENABLE}:${addon.id}`,
      )
      .row();
  } else {
    keyboard.text(t("addons.detail.test"), `${ADDONS_TEST}:${addon.id}:${accountId}`).row();
    keyboard.text(t("addons.profile.ask_admin"), `${ADDONS_ASK}:${addon.id}`).row();
  }

  keyboard.text(t("addons.menu.back"), ADDONS_LIST);
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildProfileText(
  addon: InstalledAddon,
  profile: AddonProfile,
  accountId: number,
): string {
  const lines = [
    t("addons.profile.title", { name: addon.manifest?.name ?? addon.id }),
    `${accountId}`,
    "",
  ];
  for (const [key, field] of Object.entries(addon.manifest?.config ?? {})) {
    lines.push(`${field.label ?? key}: ${fieldValue(profile, key)}`);
  }
  return lines.join("\n");
}

export function buildProfileKeyboard(
  addon: InstalledAddon,
  profile: AddonProfile,
  accountId: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [key, field] of Object.entries(addon.manifest?.config ?? {})) {
    const label = `${field.label ?? key}: ${fieldValue(profile, key)}`;
    keyboard.text(label.slice(0, 64), `${ADDONS_FIELD}:${addon.id}:${accountId}:${key}`).row();
  }
  keyboard.text(t("addons.detail.secrets"), `${ADDONS_SECRETS}:${addon.id}:${accountId}`).row();
  keyboard.text(t("addons.menu.back"), `${ADDONS_OPEN}:${addon.id}`);
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildFieldText(
  field: AddonConfigField,
  key: string,
  profile: AddonProfile,
): string {
  return [
    t("addons.config.field", { label: field.label ?? key }),
    t("addons.config.current", { value: fieldValue(profile, key) }),
  ].join("\n");
}

function enumLabel(key: string, value: string): string {
  if (key === "attachments") {
    if (value === "none") return t("addons.attachments.none");
    if (value === "download") return t("addons.attachments.download");
    return t("addons.attachments.list");
  }
  return value;
}

export function buildFieldKeyboard(
  addon: InstalledAddon,
  profile: AddonProfile,
  accountId: number,
  key: string,
  field: AddonConfigField,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const prefix = `${ADDONS_SET}:${addon.id}:${accountId}:${key}`;

  switch (field.type) {
    case "enum":
      for (const value of field.values) {
        const current = profile[key] === value ? "✓ " : "";
        keyboard.text(`${current}${enumLabel(key, value)}`.slice(0, 64), `${prefix}:${value}`).row();
      }
      break;
    case "boolean":
      keyboard
        .text(`✓ ${t("addons.boolean.yes")}`, `${prefix}:true`)
        .text(`${t("addons.boolean.no")}`, `${prefix}:false`)
        .row();
      break;
    case "number":
    case "string":
    case "string[]":
      keyboard.text(t("addons.field.change"), `${ADDONS_EDIT}:${addon.id}:${accountId}:${key}`).row();
      break;
  }

  keyboard.text(t("addons.menu.back"), `${ADDONS_PROFILE}:${addon.id}:${accountId}`);
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildSecretEntryText(
  addon: InstalledAddon,
  entry: SecretStatus,
): string {
  return [
    t("addons.profile.title", { name: addon.manifest?.name ?? addon.id }),
    "",
    `${entry.label} (${entry.key})`,
    t(entry.set ? "addons.secret.set" : "addons.secret.unset"),
  ].join("\n");
}

export function buildSecretEntryKeyboard(
  addon: InstalledAddon,
  accountId: number,
  entry: SecretStatus,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard
    .text(
      t("addons.secret.enter"),
      `${ADDONS_SECRET_ASK}:${addon.id}:${accountId}:${entry.key}`,
    )
    .row();
  if (entry.set) {
    keyboard
      .text(
        t("addons.secret.delete"),
        `${ADDONS_SECRET_DELETE}:${addon.id}:${accountId}:${entry.key}`,
      )
      .row();
  }
  keyboard.text(t("addons.menu.back"), `${ADDONS_SECRETS}:${addon.id}:${accountId}`);
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildAccountsText(addon: InstalledAddon, rows: AccountRow[]): string {
  const lines = [t("addons.accounts.title", { name: addon.manifest?.name ?? addon.id }), ""];
  if (rows.length === 0) {
    lines.push(t("addons.accounts.none"));
  } else {
    for (const row of rows) {
      lines.push(
        `${GRANT_EMOJI[row.grant]} ` +
          t("addons.accounts.line", {
            id: String(row.accountId),
            grant: t(row.grant === "use" ? "addons.grant.use" : "addons.grant.off"),
          }) +
          (row.configured ? "" : ` · ${t("addons.accounts.not_configured")}`),
      );
    }
    lines.push("");
    lines.push(t("addons.accounts.hint"));
  }
  return lines.join("\n");
}

export function buildAccountsKeyboard(addon: InstalledAddon, rows: AccountRow[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    keyboard
      .text(
        `${GRANT_EMOJI[row.grant]} ${row.accountId}`.slice(0, 64),
        `${ADDONS_ACCOUNT}:${addon.id}:${row.accountId}`,
      )
      .row();
  }
  keyboard.text(t("addons.accounts.add"), `${ADDONS_ADD_ACCOUNT}:${addon.id}`).row();
  keyboard.text(t("addons.menu.back"), `${ADDONS_OPEN}:${addon.id}`);
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildAccountText(
  addon: InstalledAddon,
  accountId: number,
  grant: AddonGrant,
  profile: AddonProfile,
): string {
  const lines = [
    t("addons.profile.title", { name: addon.manifest?.name ?? addon.id }),
    `${accountId} · ${t(grant === "use" ? "addons.grant.use" : "addons.grant.off")}`,
    "",
  ];
  for (const [key, field] of Object.entries(addon.manifest?.config ?? {})) {
    lines.push(`${field.label ?? key}: ${fieldValue(profile, key)}`);
  }
  return lines.join("\n");
}

export function buildAccountKeyboard(
  addon: InstalledAddon,
  accountId: number,
  grant: AddonGrant,
  profile: AddonProfile,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [key, field] of Object.entries(addon.manifest?.config ?? {})) {
    keyboard
      .text(
        `${field.label ?? key}: ${fieldValue(profile, key)}`.slice(0, 64),
        `${ADDONS_FIELD}:${addon.id}:${accountId}:${key}`,
      )
      .row();
  }
  keyboard
    .text(t("addons.detail.secrets"), `${ADDONS_SECRETS}:${addon.id}:${accountId}`)
    .row();
  keyboard
    .text(
      `${GRANT_EMOJI[grant]} ${t("addons.grant.use")} / ${t("addons.grant.off")}`,
      `${ADDONS_GRANT}:${addon.id}:${accountId}`,
    )
    .row();
  keyboard.text(t("addons.menu.back"), `${ADDONS_ACCOUNTS}:${addon.id}`);
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildSecretsText(
  addon: InstalledAddon,
  accountId: number,
  status: SecretStatus[],
): string {
  const lines = [
    t("addons.profile.title", { name: addon.manifest?.name ?? addon.id }),
    `${accountId}`,
    "",
  ];
  if (status.length === 0) {
    lines.push(t("addons.secret.unset"));
  }
  for (const entry of status) {
    lines.push(
      `${entry.key}: ${t(entry.set ? "addons.secret.set" : "addons.secret.unset")}`,
    );
  }
  return lines.join("\n");
}

export function buildSecretsKeyboard(
  addon: InstalledAddon,
  accountId: number,
  status: SecretStatus[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const entry of status) {
    const short = entry.key.replace(/^MAIL_IMAP_/, "").slice(0, 24);
    keyboard
      .text(`${entry.set ? "✓ " : ""}${short}`.slice(0, 64), `${ADDONS_SECRET}:${addon.id}:${accountId}:${entry.key}`)
      .row();
  }
  keyboard.text(t("addons.menu.back"), `${ADDONS_PROFILE}:${addon.id}:${accountId}`);
  keyboard.text(t("inline.button.cancel"), ADDONS_CANCEL);
  return keyboard;
}

export function buildEnableAgentsText(addon: InstalledAddon): string {
  return [
    t("addons.detail.header", {
      name: addon.manifest?.name ?? addon.id,
      state: t("addons.detail.enable"),
    }),
    "",
    t("addons.enable.agent_prompt"),
  ].join("\n");
}

export function buildEnableAgentsKeyboard(addon: InstalledAddon): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("addons.enable.agent.social_media"), `${ADDONS_ENABLE_AGENT}:${addon.id}:social-media`)
    .row()
    .text(t("addons.enable.agent.postiz_social"), `${ADDONS_ENABLE_AGENT}:${addon.id}:postiz-social`)
    .row()
    .text(t("addons.enable.agent.all"), `${ADDONS_ENABLE_AGENT}:${addon.id}:all`)
    .row()
    .text(t("addons.menu.back"), `${ADDONS_OPEN}:${addon.id}`)
    .text(t("inline.button.cancel"), ADDONS_CANCEL);
}

export function agentList(choice: string): string[] {
  if (choice === "all") return ["social-media", "postiz-social"];
  if (choice === "social-media" || choice === "postiz-social") return [choice];
  return [];
}

export function buildEnableConfirmText(addon: InstalledAddon, accounts: number): string {
  const scope =
    addon.manifest?.scope === "global"
      ? t("addons.scope.global")
      : t("addons.scope.per_user");
  return t("addons.enable.confirm", {
    scope,
    accounts: String(accounts),
  });
}

export function buildDisableConfirmText(addon: InstalledAddon): string {
  return t("addons.disable.confirm", { name: addon.manifest?.name ?? addon.id });
}

export function buildDefaultConfirmText(addon: InstalledAddon): string {
  return t("addons.default.confirm", { name: addon.manifest?.name ?? addon.id });
}

export function buildModeConfirmText(accountId: number): string {
  return t("addons.config.mode_mailbox_confirm", {
    account: String(accountId),
  });
}

export function buildConfirmKeyboard(target: string, back: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("addons.boolean.yes"), target)
    .row()
    .text(t("addons.menu.back"), back)
    .text(t("inline.button.cancel"), ADDONS_CANCEL);
}

export function parseCallback(data: string): string[] | null {
  if (!data.startsWith(ADDONS_CALLBACK_PREFIX)) return null;
  return data.split(":");
}
