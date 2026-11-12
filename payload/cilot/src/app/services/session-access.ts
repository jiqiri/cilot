import { logger } from "../../utils/logger.js";
import {
  can,
  isAdminUser,
  isSessionOwned,
  getKnownUserIds,
  getOwnedSessionIds,
  claimSession,
  withSettingsUser,
} from "./access-control.js";


/**
 * Whether a Telegram account may open a session, checked at the point of use.
 *
 * `isSessionOwned` existed but had no callers: ownership filtered the `/sessions` list and
 * nothing else, so any session id that reached a handler from a callback was used without
 * being verified. Ids are not guessable, which is why this was not being exploited, but the
 * check belongs at the boundary rather than relying on that.
 *
 * Three ways a session can legitimately be reachable:
 *  - this account already owns it
 *  - this account created it and ownership has not been recorded yet, which is the normal
 *    state immediately after `/new`
 *  - the account is an admin, which is a deliberate grant rather than a side effect
 */
export async function assertSessionAccessible(
  userId: number | undefined,
  sessionId: string,
): Promise<boolean> {
  if (!userId) return false;
  if (isAdminUser(userId) && can(userId, "cross_user_sessions")) {
    return true;
  }
  // Scoped to the account being checked. Without this the ownership lookup reads whichever
  // account was active last, so asking about one account's session could be answered from
  // another's list and a standard account could be handed a session that was not its own.
  return withSettingsUser(userId, () => isSessionOwned(sessionId));
}

/**
 * Record ownership of a session this account just created, so the next check passes.
 * Kept separate from the check because creating a session and being allowed to open an
 * existing one are different decisions.
 */
export function recordSessionOwnership(userId: number | undefined, sessionId: string): void {
  if (!userId) return;
  withSettingsUser(userId, () => claimSession(sessionId));
}

/**
 * Sessions this account may see, derived from ownership rather than from a global list.
 * Used by the session menu so the list and the open path agree on one rule.
 */
export function ownedSessionIdsFor(userId: number | undefined): string[] {
  if (!userId) return [];
  if (isAdminUser(userId) && can(userId, "cross_user_sessions")) {
    return getKnownUserIds().flatMap((id) => withSettingsUser(id, () => getOwnedSessionIds()));
  }
  return withSettingsUser(userId, () => getOwnedSessionIds());
}

export function logOwnershipDecision(userId: number | undefined, sessionId: string, allowed: boolean): void {
  logger.debug(
    `[Authz] session=${sessionId} userId=${userId} allowed=${allowed} owned=${getOwnedSessionIds().length}`,
  );
}
