import type { CommandContext, Context } from "grammy";
import { isPrimaryAdmin } from "../../app/services/access-control.js";
import {
  deleteSharedFolder,
  grantSharedFolder,
  isValidSharedFolderName,
  listSharedFolders,
  revokeSharedFolderGrants,
} from "../../app/services/shared-folders-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

/**
 * /share — the primary admin's shared-folder grants.
 *
 * A shared folder is the only way two accounts can see the same files, and it is opt-in:
 * creating one and naming the ids is a deliberate act by the first admin, not something a
 * standard account can request. Everything else stays inside `users/<telegram id>`.
 *
 * Refused for every other account by the command router; the check here is the second gate.
 */
export async function shareCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isPrimaryAdmin(ctx.from?.id)) {
    await ctx.reply(t("share.not_permitted"));
    return;
  }

  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const action = (args[0] ?? "list").toLowerCase();

  try {
    if (action === "list") {
      const folders = listSharedFolders();
      if (folders.length === 0) {
        await ctx.reply(t("share.none"));
        return;
      }
      const entries = folders
        .map((folder) => `${folder.name} → ${folder.userIds.join(", ")}`)
        .join("\n");
      await ctx.reply(t("share.list", { entries }));
      return;
    }

    if (action === "add" || action === "remove") {
      const name = args[1];
      const ids = parseIds(args[2]);

      if (!name || !isValidSharedFolderName(name)) {
        await ctx.reply(t("share.invalid_name"));
        return;
      }
      if (!ids || ids.length === 0) {
        await ctx.reply(t("share.invalid_ids"));
        return;
      }
      if (args.length > 3) {
        await ctx.reply(t("share.usage"));
        return;
      }

      if (action === "add") {
        const folder = await grantSharedFolder(name, ids);
        await ctx.reply(t("share.added", { name, ids: folder.userIds.join(", ") }));
      } else {
        await revokeSharedFolderGrants(name, ids);
        await ctx.reply(t("share.removed", { ids: ids.join(", "), name }));
      }
      logger.info(`[Shares] ${action} ${name} for ${ids.join(",")} by the primary admin`);
      return;
    }

    if (action === "delete") {
      const name = args[1];
      if (!name || !isValidSharedFolderName(name) || args.length > 2) {
        await ctx.reply(t("share.usage"));
        return;
      }
      const removed = await deleteSharedFolder(name);
      await ctx.reply(removed ? t("share.deleted", { name }) : t("share.none"));
      return;
    }

    await ctx.reply(t("share.usage"));
  } catch (error) {
    logger.error("[Shares] Could not update shared folders:", error);
    await ctx.reply(
      t("share.failed", { error: (error as Error).message || t("common.unknown_error") }),
    );
  }
}

function parseIds(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const parts = raw.split(",").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !/^\d+$/.test(part))) return null;

  const ids = parts.map((part) => Number.parseInt(part, 10));
  return ids.every((id) => Number.isSafeInteger(id) && id > 0) ? ids : null;
}
