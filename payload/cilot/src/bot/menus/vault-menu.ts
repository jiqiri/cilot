import { InlineKeyboard } from "grammy";
import { t } from "../../i18n/index.js";
import type { SecretEntrySummary } from "../../app/services/secret-store-service.js";
import {
  summarizeConnection,
  type ProviderIntegration,
} from "../../app/services/provider-integration-service.js";

/**
 * Vault menu: inline keyboards and the text that goes above them.
 *
 * The vault is split in two on purpose. Model providers are already handled by the server's
 * integration API, while "biến môi trường" are arbitrary variables the operator defines for
 * their own tools. They are different stores with different lifetimes, so they get different
 * screens rather than one list that hides the distinction.
 */

export const VAULT_CALLBACK_PREFIX = "vault:";
export const VAULT_MAIN_CALLBACK = `${VAULT_CALLBACK_PREFIX}main`;
export const VAULT_CLOSE_CALLBACK = `${VAULT_CALLBACK_PREFIX}close`;

export const VAULT_ENV_LIST_CALLBACK = `${VAULT_CALLBACK_PREFIX}env`;
export const VAULT_ENV_ADD_CALLBACK = `${VAULT_CALLBACK_PREFIX}env:add`;
export const VAULT_ENV_OPEN_PREFIX = `${VAULT_CALLBACK_PREFIX}env:open:`;
export const VAULT_ENV_SET_PREFIX = `${VAULT_CALLBACK_PREFIX}env:set:`;
export const VAULT_ENV_DELETE_PREFIX = `${VAULT_CALLBACK_PREFIX}env:del:`;
export const VAULT_ENV_DELETE_CONFIRM_PREFIX = `${VAULT_CALLBACK_PREFIX}env:delok:`;

export const VAULT_PROVIDER_LIST_CALLBACK = `${VAULT_CALLBACK_PREFIX}prov`;
export const VAULT_PROVIDER_SEARCH_CALLBACK = `${VAULT_CALLBACK_PREFIX}prov:search`;
export const VAULT_PROVIDER_PAGE_PREFIX = `${VAULT_CALLBACK_PREFIX}prov:all:`;
export const VAULT_PROVIDER_OPEN_PREFIX = `${VAULT_CALLBACK_PREFIX}prov:open:`;
export const VAULT_PROVIDER_KEY_PREFIX = `${VAULT_CALLBACK_PREFIX}prov:key:`;
export const VAULT_PROVIDER_DISCONNECT_PREFIX = `${VAULT_CALLBACK_PREFIX}prov:disc:`;

export const VAULT_RESTART_CALLBACK = `${VAULT_CALLBACK_PREFIX}restart`;

export const VAULT_PROVIDER_PAGE_SIZE = 10;

// Telegram rejects longer inline button labels outright.
const MAX_INLINE_BUTTON_LABEL_LENGTH = 64;

function truncateLabel(label: string): string {
  if (label.length <= MAX_INLINE_BUTTON_LABEL_LENGTH) {
    return label;
  }
  return `${label.slice(0, MAX_INLINE_BUTTON_LABEL_LENGTH - 3)}...`;
}

/** Read the argument of `prefix<arg>`, or null when the callback is something else. */
export function parseCallbackArgument(data: string, prefix: string): string | null {
  if (!data.startsWith(prefix)) {
    return null;
  }
  const argument = data.slice(prefix.length);
  return argument.length > 0 ? argument : null;
}

export function providerPageCallback(page: number): string {
  return `${VAULT_PROVIDER_PAGE_PREFIX}${page}`;
}

export function parseProviderPage(data: string): number | null {
  const argument = parseCallbackArgument(data, VAULT_PROVIDER_PAGE_PREFIX);
  if (argument === null || !/^\d+$/.test(argument)) {
    return null;
  }
  const page = Number(argument);
  return Number.isInteger(page) && page >= 1 ? page : null;
}

export function formatVaultMainText(envCount: number, providerCount: number): string {
  return t("vault.title", { envCount, providerCount });
}

export function buildVaultMainKeyboard(envCount: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(truncateLabel(t("vault.button.env", { count: envCount })), VAULT_ENV_LIST_CALLBACK)
    .row()
    .text(t("vault.button.providers"), VAULT_PROVIDER_LIST_CALLBACK)
    .row()
    .text(t("inline.button.close"), VAULT_CLOSE_CALLBACK);
}

export function formatVaultEnvListText(entries: SecretEntrySummary[]): string {
  const header = entries.length === 0 ? t("vault.env.empty") : t("vault.env.title");
  const lines = [header];

  if (entries.length > 0) {
    lines.push("");
    for (const entry of entries) {
      lines.push(`• ${entry.label} — ${entry.name} — ${entry.maskedValue}`);
    }
  }

  return lines.join("\n");
}

export function buildVaultEnvListKeyboard(entries: SecretEntrySummary[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const entry of entries) {
    keyboard.text(truncateLabel(`🔐 ${entry.label}`), `${VAULT_ENV_OPEN_PREFIX}${entry.id}`).row();
  }

  keyboard.text(t("vault.env.button.add"), VAULT_ENV_ADD_CALLBACK).row();

  if (entries.length > 0) {
    keyboard.text(t("vault.button.restart"), VAULT_RESTART_CALLBACK).row();
  }

  return keyboard
    .text(t("vault.button.back"), VAULT_MAIN_CALLBACK)
    .text(t("inline.button.close"), VAULT_CLOSE_CALLBACK);
}

export function formatVaultEnvDetailText(entry: SecretEntrySummary): string {
  return t("vault.env.detail", {
    label: entry.label,
    name: entry.name,
    masked: entry.maskedValue,
    updated: entry.updatedAt,
  });
}

export function buildVaultEnvDetailKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("vault.env.button.set"), `${VAULT_ENV_SET_PREFIX}${id}`)
    .row()
    .text(t("vault.env.button.delete"), `${VAULT_ENV_DELETE_PREFIX}${id}`)
    .row()
    .text(t("vault.button.back"), VAULT_ENV_LIST_CALLBACK)
    .text(t("inline.button.close"), VAULT_CLOSE_CALLBACK);
}

export function buildVaultEnvDeleteKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("vault.env.button.delete_confirm"), `${VAULT_ENV_DELETE_CONFIRM_PREFIX}${id}`)
    .row()
    .text(t("inline.button.cancel"), `${VAULT_ENV_OPEN_PREFIX}${id}`);
}

export function formatVaultProviderListText(): string {
  return t("vault.provider.title");
}

export function buildVaultProviderListKeyboard(integrations: ProviderIntegration[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const integration of integrations) {
    const connected = summarizeConnection(integration).connected ? "✅ " : "";
    keyboard
      .text(
        truncateLabel(`${connected}${integration.name}`),
        `${VAULT_PROVIDER_OPEN_PREFIX}${integration.id}`,
      )
      .row();
  }

  return keyboard
    .text(t("vault.provider.button.search"), VAULT_PROVIDER_SEARCH_CALLBACK)
    .text(t("vault.provider.button.all"), providerPageCallback(1))
    .row()
    .text(t("vault.button.back"), VAULT_MAIN_CALLBACK)
    .text(t("inline.button.close"), VAULT_CLOSE_CALLBACK);
}

export function providerPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / VAULT_PROVIDER_PAGE_SIZE));
}

export function sliceProviderPage<T>(items: T[], page: number): T[] {
  const start = (page - 1) * VAULT_PROVIDER_PAGE_SIZE;
  return items.slice(start, start + VAULT_PROVIDER_PAGE_SIZE);
}

export function formatVaultProviderPageText(page: number, pages: number, total: number): string {
  return t("vault.provider.page", { page, pages, total });
}

export function buildVaultProviderPageKeyboard(
  pageItems: ProviderIntegration[],
  page: number,
  pages: number,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const integration of pageItems) {
    const connected = summarizeConnection(integration).connected ? "✅ " : "";
    keyboard
      .text(
        truncateLabel(`${connected}${integration.name}`),
        `${VAULT_PROVIDER_OPEN_PREFIX}${integration.id}`,
      )
      .row();
  }

  if (pages > 1) {
    if (page > 1) {
      keyboard.text("⬅️", providerPageCallback(page - 1));
    }
    keyboard.text(`${page}/${pages}`, VAULT_PROVIDER_LIST_CALLBACK);
    if (page < pages) {
      keyboard.text("➡️", providerPageCallback(page + 1));
    }
    keyboard.row();
  }

  return keyboard
    .text(t("vault.provider.button.search"), VAULT_PROVIDER_SEARCH_CALLBACK)
    .row()
    .text(t("vault.button.back"), VAULT_MAIN_CALLBACK)
    .text(t("inline.button.close"), VAULT_CLOSE_CALLBACK);
}

export function formatVaultProviderSearchResultsText(query: string, results: ProviderIntegration[]): string {
  const lines = [t("vault.provider.search_results", { query, count: results.length }), ""];
  for (const integration of results) {
    lines.push(`• ${integration.name} (${integration.id})`);
  }
  return lines.join("\n");
}

export function formatVaultProviderSearchEmptyText(query: string): string {
  return t("vault.provider.search_empty", { query });
}

export function buildVaultProviderSearchResultsKeyboard(results: ProviderIntegration[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const integration of results) {
    const connected = summarizeConnection(integration).connected ? "✅ " : "";
    keyboard
      .text(
        truncateLabel(`${connected}${integration.name}`),
        `${VAULT_PROVIDER_OPEN_PREFIX}${integration.id}`,
      )
      .row();
  }

  return keyboard
    .text(t("vault.provider.button.search"), VAULT_PROVIDER_SEARCH_CALLBACK)
    .row()
    .text(t("vault.button.back"), VAULT_PROVIDER_LIST_CALLBACK)
    .text(t("inline.button.close"), VAULT_CLOSE_CALLBACK);
}

export function formatVaultProviderDetailText(integration: ProviderIntegration): string {
  const summary = summarizeConnection(integration);
  const status = summary.connected
    ? t("vault.provider.status.connected", {
        via: summary.label ?? summary.envName ?? "—",
      })
    : t("vault.provider.status.missing");

  return t("vault.provider.detail", {
    name: integration.name,
    id: integration.id,
    status,
  });
}

export function buildVaultProviderDetailKeyboard(
  integration: ProviderIntegration,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const summary = summarizeConnection(integration);

  if (integration.methods.some((method) => method.type === "key")) {
    keyboard
      .text(t("vault.provider.button.connect"), `${VAULT_PROVIDER_KEY_PREFIX}${integration.id}`)
      .row();
  }

  if (summary.credentialId) {
    keyboard
      .text(
        t("vault.provider.button.disconnect"),
        `${VAULT_PROVIDER_DISCONNECT_PREFIX}${integration.id}`,
      )
      .row();
  }

  return keyboard
    .text(t("vault.button.back"), VAULT_PROVIDER_LIST_CALLBACK)
    .text(t("inline.button.close"), VAULT_CLOSE_CALLBACK);
}
