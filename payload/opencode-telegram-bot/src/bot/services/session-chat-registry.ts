/**
 * Which Telegram chat a session's messages belong to.
 *
 * The event bridge receives messages for sessions with no update attached, so it cannot
 * ask "who sent this?". The chat that last spoke in a session is recorded when an update
 * arrives, and background notices for that session go back to the same chat instead of to
 * whichever account happened to message most recently.
 */
const sessionChatBySessionId = new Map<string, number>();

export function recordSessionChat(sessionId: string | undefined, chatId: number | undefined): void {
  if (!sessionId || !chatId) {
    return;
  }
  sessionChatBySessionId.set(sessionId, chatId);
}

export function getSessionChat(sessionId: string): number | undefined {
  return sessionChatBySessionId.get(sessionId);
}

/**
 * The Telegram account that owns a session, for work that arrives with no update attached.
 *
 * The event stream is global, so a handler reacting to a session's output has no idea which
 * account started it. Without this, anything that consults the per-account settings from an
 * event - is this the session the account is following, is that account busy, whose
 * interaction slot is open - resolves against whichever account messaged last, and the reply
 * goes to the wrong person or is suppressed.
 *
 * For a private chat the chat id is the account id, which is what `recordSessionChat` stores.
 * Returns undefined for a session nobody has spoken in, and callers treat that as "no
 * owning account" rather than defaulting to the primary one.
 */
export function getSessionOwnerUserId(sessionId: string): number | undefined {
  return sessionChatBySessionId.get(sessionId);
}

export function clearSessionChatRegistry(): void {
  sessionChatBySessionId.clear();
}
