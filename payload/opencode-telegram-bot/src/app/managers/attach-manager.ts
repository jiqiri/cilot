import { logger } from "../../utils/logger.js";
import { getActiveSettingsUser } from "../stores/settings-store.js";

export interface AttachedSessionState {
  sessionId: string;
  directory: string;
  busy: boolean;
}

/**
 * The session each account is attached to, held separately per account.
 *
 * This held one session for the whole process, so attaching in one chat detached the other
 * chat, and one account's attached session going busy blocked the other. Keyed by the active
 * account, which the auth middleware scopes per update and the event bridge scopes per
 * session owner, so a call from either side resolves to the right account without the caller
 * having to pass one.
 */
export class AttachManager {
  private readonly states = new Map<number | null, AttachedSessionState>();

  private get state(): AttachedSessionState | null {
    return this.states.get(getActiveSettingsUser()) ?? null;
  }

  private set state(value: AttachedSessionState | null) {
    const key = getActiveSettingsUser();
    if (value) {
      this.states.set(key, value);
    } else {
      this.states.delete(key);
    }
  }

  attach(sessionId: string, directory: string): void {
    this.state = {
      sessionId,
      directory,
      busy: false,
    };

    logger.info(`[Attach] Attached to session: session=${sessionId}, directory=${directory}`);
  }

  clear(reason: string): void {
    if (!this.state) {
      return;
    }

    logger.info(
      `[Attach] Cleared attached session: reason=${reason}, session=${this.state.sessionId}, directory=${this.state.directory}`,
    );
    this.state = null;
  }

  getSnapshot(): AttachedSessionState | null {
    return this.state ? { ...this.state } : null;
  }

  isAttached(): boolean {
    return this.state !== null;
  }

  isAttachedSession(sessionId: string | null | undefined, directory?: string): boolean {
    if (!this.state || !sessionId) {
      return false;
    }

    if (this.state.sessionId !== sessionId) {
      return false;
    }

    if (directory && this.state.directory !== directory) {
      return false;
    }

    return true;
  }

  isBusy(): boolean {
    return this.state?.busy === true;
  }

  markBusy(sessionId: string): boolean {
    const entry = this.state;
    if (!entry || entry.sessionId !== sessionId) {
      return false;
    }

    if (entry.busy) {
      return false;
    }

    entry.busy = true;
    logger.info(`[Attach] Marked attached session busy: session=${sessionId}`);
    return true;
  }

  markIdle(sessionId: string): boolean {
    const entry = this.state;
    if (!entry || entry.sessionId !== sessionId) {
      return false;
    }

    if (!entry.busy) {
      return false;
    }

    entry.busy = false;
    logger.info(`[Attach] Marked attached session idle: session=${sessionId}`);
    return true;
  }
}
