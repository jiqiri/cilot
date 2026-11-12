import type { CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { isElevatedUser, isPrimaryAdmin } from "../../app/services/access-control.js";
import {
  allowUser,
  blockUser,
  deleteUser,
  listUserRecords,
} from "../../app/services/user-directory-service.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";

/**
 * /user — who may use the bot, with buttons instead of typed commands.
 *
 * This is the replacement for the "ban a user" half of the old `/access` switch. Banning is
 * an account decision, not a machine one, and it belongs next to adding the account in the
 * first place:
 *
 * - **Add** allows the id, or lifts an earlier block, and applies on the next update.
 * - **Block** refuses the id at the auth middleware and keeps every file it owns.
 * - **Delete** blocks and then removes the workspace, settings, sessions, images and grants.
 *
 * Only the first admin may use it, and only while `/access on` is in effect: an account that
 * can change who may use the bot is part of the machine's full reach, not of the safe
 * default. The command router refuses `/user` in the same conditions; the checks below cover
 * the button and text paths, which do not go through it.
 */

type PendingAction = "add" | "block" | "delete";

const PENDING_TTL_MS = 120_000;

// One pending step per admin chat. A short map is enough: the flow is "press a button, send
// one id", and an entry is cleared by the reply or by its own deadline.
const pending = new Map<number, { action: PendingAction; expiresAt: number }>();

function isAllowedHere(userId: number | undefined): boolean {
  return isPrimaryAdmin(userId) && isElevatedUser(userId);
}

function menuText(): string {
  const records = listUserRecords();
  const admins = config.telegram.adminUserIds;
  const entries = records.length
    ? records
        .map((record) =>
          record.status === "active"
            ? t("user.entry.active", { id: String(record.id) })
            : t("user.entry.blocked", { id: String(record.id) }),
        )
        .join("\n")
    : t("user.none");

  return t("user.menu", {
    entries,
    admins: admins.join(", ") || t("user.none"),
    environment: config.telegram.allowedUserIds
      .filter((id) => !admins.includes(id))
      .join(", ") || t("user.none"),
  });
}

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("user.btn.add"), "user:add")
    .text(t("user.btn.block"), "user:block")
    .row()
    .text(t("user.btn.delete"), "user:delete")
    .text(t("user.btn.cancel"), "user:cancel");
}

export async function userCommand(ctx: CommandContext<Context>): Promise<void> {
  if (!isPrimaryAdmin(ctx.from?.id)) {
    await ctx.reply(t("user.not_permitted"));
    return;
  }
  if (!isElevatedUser(ctx.from?.id)) {
    await ctx.reply(t("user.needs_access"));
    return;
  }

  await ctx.reply(menuText(), { reply_markup: menuKeyboard() });
}

/** Handles `user:*` callbacks. Returns true when the update was consumed. */
export async function handleUserCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith("user:")) return false;

  const userId = ctx.from?.id;

  if (!isAllowedHere(userId)) {
    await ctx.answerCallbackQuery({ text: t("user.not_permitted") }).catch(() => undefined);
    return true;
  }

  const [, action, target] = data.split(":");
  await ctx.answerCallbackQuery().catch(() => undefined);

  try {
    if (action === "cancel") {
      pending.delete(userId as number);
      await ctx.editMessageText(t("common.cancelled")).catch(() => undefined);
      return true;
    }

    if (action === "add" || action === "block" || action === "delete") {
      pending.set(userId as number, {
        action: action as PendingAction,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });
      await ctx.editMessageText(t("user.prompt_id"), { reply_markup: cancelKeyboard() });
      return true;
    }

    if (action === "confirm") {
      const id = Number(target);
      if (!Number.isFinite(id) || id <= 0) {
        await ctx.editMessageText(t("user.invalid_id")).catch(() => undefined);
        return true;
      }
      await runDelete(ctx, id);
      return true;
    }
  } catch (error) {
    logger.error("[UserCommand] Could not handle the user menu", error);
    await ctx.reply(t("user.failed", { error: (error as Error).message || t("common.unknown_error") }));
  }

  return true;
}

/**
 * Consumes the id typed after Add / Block / Delete. Returns true when the text belonged to
 * this flow, so the router does not treat it as a prompt for OpenCode.
 */
export async function handleUserTextInput(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId === undefined) return false;

  const waiting = pending.get(userId);
  if (!waiting) return false;

  if (Date.now() > waiting.expiresAt) {
    pending.delete(userId);
    return false;
  }

  const text = ctx.message?.text?.trim();
  if (!text || !isAllowedHere(userId)) {
    return false;
  }

  const id = parseTelegramId(text);
  if (id === null) {
    await ctx.reply(t("user.invalid_id"));
    return true;
  }

  pending.delete(userId);

  if (config.telegram.adminUserIds.includes(id)) {
    // Admin ids come from configuration, so the operator can always recover an account
    // through the same file they used to create it.
    await ctx.reply(t("user.cannot_target_admin"));
    return true;
  }

  try {
    if (waiting.action === "add") {
      await allowUser(id);
      logger.info(`[UserCommand] Allowed userId=${id} by the primary admin`);
      await ctx.reply(t("user.added", { id: String(id) }), { reply_markup: menuKeyboard() });
      return true;
    }

    if (waiting.action === "block") {
      await blockUser(id);
      logger.info(`[UserCommand] Blocked userId=${id} by the primary admin`);
      await ctx.reply(t("user.blocked", { id: String(id) }), { reply_markup: menuKeyboard() });
      return true;
    }

    await ctx.reply(t("user.confirm_delete", { id: String(id) }), {
      reply_markup: new InlineKeyboard()
        .text(t("user.btn.confirm"), `user:confirm:${id}`)
        .text(t("user.btn.cancel"), "user:cancel"),
    });
  } catch (error) {
    logger.error("[UserCommand] Could not update the user list", error);
    await ctx.reply(t("user.failed", { error: (error as Error).message || t("common.unknown_error") }));
  }

  return true;
}

async function runDelete(ctx: Context, id: number): Promise<void> {
  if (config.telegram.adminUserIds.includes(id)) {
    await ctx.editMessageText(t("user.cannot_target_admin")).catch(() => undefined);
    return;
  }

  const report = await deleteUser(id);
  logger.warn(`[UserCommand] Deleted userId=${id} by the primary admin: ${JSON.stringify(report)}`);

  await ctx.editMessageText(
    t("user.deleted", {
      id: String(id),
      workspace: report.workspaceRemoved ? "✅" : "❌",
      sessions: String(report.sessionsDeleted),
      images: String(report.imagesDeleted),
      shares: String(report.sharesRevoked),
    }),
  ).catch(() => undefined);
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(t("user.btn.cancel"), "user:cancel");
}

/** Telegram ids are positive integers; anything else is a typo, not an id. */
function parseTelegramId(text: string): number | null {
  if (!/^\d{5,20}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Test hook: drop a pending step left by an earlier case. */
export function __resetUserCommandForTests(): void {
  pending.clear();
}
