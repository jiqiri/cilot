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

export function clearSessionChatRegistry(): void {
  sessionChatBySessionId.clear();
}
