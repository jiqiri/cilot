import { logger } from "../../utils/logger.js";

export interface ForegroundBusySession {
  sessionId: string;
  directory: string;
  markedAt: number;
}

export class ForegroundSessionState {
  private activeSessions = new Map<string, ForegroundBusySession>();

  markBusy(sessionId: string, directory: string): void {
    if (!sessionId || !directory) {
      return;
    }

    this.activeSessions.set(sessionId, { sessionId, directory, markedAt: Date.now() });
    logger.debug(
      `[ScheduledTaskForeground] Marked session busy: session=${sessionId}, directory=${directory}, count=${this.activeSessions.size}`,
    );
  }

  markIdle(sessionId: string): void {
    if (!sessionId) {
      return;
    }

    this.activeSessions.delete(sessionId);
    logger.debug(
      `[ScheduledTaskForeground] Marked session idle: session=${sessionId}, count=${this.activeSessions.size}`,
    );
  }

  getBusySessions(): ForegroundBusySession[] {
    return Array.from(this.activeSessions.values(), (session) => ({ ...session }));
  }

  /**
   * Whether a specific session is running.
   *
   * This is what the input guard must ask. `isBusy()` below answers "is anything running",
   * which with one shared bot meant that while one account's agent was working, every other
   * account was told to wait: the check is not about the account asking, it is about the
   * process. Two accounts in different projects and different sessions blocked each other
   * for no reason.
   */
  isSessionBusy(sessionId: string | null | undefined): boolean {
    if (!sessionId) {
      return false;
    }
    return this.activeSessions.has(sessionId);
  }

  /**
   * Whether any session is running. Correct for whole-process decisions such as shutdown,
   * and wrong for "may this account send a message right now".
   */
  isBusy(): boolean {
    return this.activeSessions.size > 0;
  }

  clearAll(reason: string): void {
    if (this.activeSessions.size === 0) {
      return;
    }

    logger.info(
      `[ScheduledTaskForeground] Cleared foreground busy state: reason=${reason}, count=${this.activeSessions.size}`,
    );
    this.activeSessions.clear();
  }

  __setMarkedAtForTests(sessionId: string, markedAt: number): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      return;
    }

    this.activeSessions.set(sessionId, { ...session, markedAt });
  }
}
