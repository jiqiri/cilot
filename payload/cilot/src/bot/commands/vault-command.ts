import type { CommandContext, Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { logger } from "../../utils/logger.js";
import { t } from "../../i18n/index.js";
import { showVaultMenu } from "../callbacks/vault-callback-handler.js";

export type VaultCommandDeps = Pick<
  AppContainer,
  "interactionManager" | "foregroundSessionState" | "attachManager"
>;

/**
 * /vault — credentials and environment secrets.
 *
 * The access check lives in `showVaultMenu`, not here: the menu is also reached from a text
 * step that has to re-check, so one place decides rather than two that can diverge.
 */
export async function vaultCommand(
  ctx: CommandContext<Context>,
  deps: VaultCommandDeps,
): Promise<void> {
  try {
    await showVaultMenu(ctx, deps);
  } catch (error) {
    logger.error("[Vault] Error opening the vault menu:", error);
    await ctx.reply(t("vault.error", { error: (error as Error).message ?? "unknown" }));
  }
}
