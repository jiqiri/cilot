import { Context, NextFunction } from "grammy";
import { config } from "../../config.js";
import { runAsSettingsUser, setActiveSettingsUser } from "../../app/stores/settings-store.js";
import { logger } from "../../utils/logger.js";
import { isAuthorizedUser, policyForUser } from "../../app/services/access-control.js";

/**
 * Whether an id may use the bot at all.
 *
 * Delegates to the policy module so the entry point and the rest of the bot cannot disagree
 * about who is allowed. An id that is neither an admin nor in the allowlist is denied, which
 * is also the answer for an id that was never configured: adding a user has to be a
 * deliberate edit, not a side effect of the bot being reachable.
 */
export function isAllowedUser(userId: number | undefined): boolean {
  return isAuthorizedUser(userId);
}

export async function authMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  const userId = ctx.from?.id;

  logger.debug(
    `[Auth] Checking access: userId=${userId}, policy=${policyForUser(userId)}, ` +
      `admins=[${config.telegram.adminUserIds.join(",")}], ` +
      `allowed=[${config.telegram.allowedUserIds.join(",")}], ` +
      `hasCallbackQuery=${!!ctx.callbackQuery}, hasMessage=${!!ctx.message}`,
  );

  if (isAllowedUser(userId)) {
    // Settings are stored per Telegram account, and the account has to be bound to this
    // update's async context rather than to a shared variable. grammy runs updates
    // concurrently, so two people using the bot at once have their handlers interleaved;
    // with a shared value, whichever user arrived last would supply the project, session
    // and persona for both of them. runAsSettingsUser scopes it to this update and
    // restores it afterwards, so overlapping updates cannot see each other's account.
    setActiveSettingsUser(userId ?? null);
    logger.debug(`[Auth] Access granted for userId=${userId}`);
    await runAsSettingsUser(userId ?? null, () => next());
  } else {
    // Silently ignore unauthorized users
    logger.warn(`Unauthorized access attempt from user ID: ${userId}`);

    // Actively hide commands for unauthorized users by setting empty command list
    // Only do this if the chat is NOT an authorized user's chat
    // (to avoid resetting commands when forwarded messages are received)
    if (ctx.chat?.id && !config.telegram.allowedUserIds.includes(ctx.chat.id)) {
      try {
        // Set empty commands for this specific chat (more reliable than deleteMyCommands)
        await ctx.api.setMyCommands([], {
          scope: { type: "chat", chat_id: ctx.chat.id },
        });
        logger.debug(`[Auth] Set empty commands for unauthorized chat_id=${ctx.chat.id}`);
      } catch (err) {
        // Ignore errors
        logger.debug(`[Auth] Could not set empty commands: ${err}`);
      }
    }
  }
}
