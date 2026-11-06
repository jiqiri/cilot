import type { CommandContext, Context } from "grammy";
import { isPrimaryAdmin, userWorkspaceBase } from "../../app/services/access-control.js";
import {
  isAccessElevated,
  setAccessElevated,
} from "../../app/services/user-access-service.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { invalidateCommandMenu } from "../routers/command-menu-state.js";

/**
 * /access — the primary admin's elevation switch.
 *
 * The bot boots in the safe state: every account, the admin included, is confined to its own
 * workspace and has no shell, no filesystem browsing, no vault and no server control. That is
 * enough for the ordinary job — chat, keep files in the account's folder, call the tools it
 * was granted — and it is what `systemctl restart` returns to.
 *
 * `/access on` restores the admin's full reach: shell-capable agents, the whole machine's
 * projects and sessions, the vault and server control. It does not widen a standard account;
 * that is decided by the user directory.
 *
 * The command itself is deliberately outside the switch, so the primary admin can always turn
 * it back on from chat. Making the safe state also block this command would mean a bad state
 * needed a console to undo.
 */
export async function accessCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isPrimaryAdmin(ctx.from?.id)) {
    await ctx.reply(t("access.not_permitted"));
    return;
  }

  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const action = (args[0] ?? "status").toLowerCase();

  try {
    if (args.length > 1) {
      await ctx.reply(t("access.usage"));
      return;
    }

    if (action === "status") {
      await ctx.reply(formatStatus());
      return;
    }

    if (action !== "on" && action !== "off") {
      await ctx.reply(t("access.usage"));
      return;
    }

    const next = action === "on";
    await setAccessElevated(next);
    // The admin's menu differs between the two states, so publish it again on the next update.
    invalidateCommandMenu(ctx.from?.id);
    logger.info(`[Access] Admin elevation ${next ? "enabled" : "disabled"} by the primary admin`);

    await ctx.reply(next ? t("access.elevated") : t("access.confined"));
  } catch (error) {
    logger.error("[Access] Could not change the access switch:", error);
    await ctx.reply(t("access.failed", { error: (error as Error).message || t("common.unknown_error") }));
  }
}

function formatStatus(): string {
  const elevated = isAccessElevated();
  const adminIds = new Set(config.telegram.adminUserIds);
  const standard = config.telegram.allowedUserIds.filter((id) => !adminIds.has(id)).length;

  return t("access.status", {
    state: elevated ? t("access.state.on") : t("access.state.off"),
    accounts: String(standard),
    root: userWorkspaceBase(),
  });
}
