import type { CommandContext, Context } from "grammy";
import { isPrimaryAdmin, userWorkspaceBase } from "../../app/services/access-control.js";
import {
  isUserAccessEnabled,
  setUserAccessEnabled,
} from "../../app/services/user-access-service.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

/**
 * /access — the primary admin's switch for standard-account access.
 *
 * The admin's own access is deliberately not switchable here. The first admin is the
 * recovery path: if the person who owns the VPS can be locked out by a command, a bad
 * switch (or a bug in one) needs console access to undo. So the admin is always full, and
 * this command only controls whether standard accounts may use the bot at all.
 *
 * Standard accounts are confined by policy, not by this flag: their workspace root, their
 * sessions, their projects, no shell, no cross-account files. Turning access off is an
 * additional kill switch on top of that, for when the machine should be admin-only.
 *
 * Refused for every other account by the command router; the check here is the second gate
 * for a path that does not go through the menu.
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
    await setUserAccessEnabled(next);
    logger.info(`[Access] Standard-user access ${next ? "enabled" : "disabled"} by the primary admin`);

    await ctx.reply(next ? t("access.enabled") : t("access.disabled"));
  } catch (error) {
    logger.error("[Access] Could not change standard-user access:", error);
    await ctx.reply(t("access.failed", { error: (error as Error).message || t("common.unknown_error") }));
  }
}

function formatStatus(): string {
  const enabled = isUserAccessEnabled();
  const accounts = config.telegram.allowedUserIds.filter(
    (id) => !config.telegram.adminUserIds.includes(id),
  ).length;

  return t("access.status", {
    state: enabled ? t("access.state.on") : t("access.state.off"),
    accounts: String(accounts),
    root: userWorkspaceBase(),
  });
}
