import { logger } from "../../utils/logger.js";
import type { IncomingPrompt } from "../types/prompt.js";

export const MAX_QUEUED_PROMPTS = 5;
/** Maximum raw Telegram media bytes retained by all queued prompts. */
export const MAX_QUEUED_MEDIA_BYTES = 20 * 1024 * 1024;

export interface QueuedPrompt extends IncomingPrompt {
  id: string;
  displayText: string;
  responseMode?: "text_only" | "text_and_tts";
  mediaBytes: number;
  /**
   * The Telegram account that sent this prompt.
   *
   * Without it, the queue is one shared FIFO and whichever run finishes first dispatches
   * whatever happens to be next, using its own chat and session. So a prompt typed by one
   * user while another user's agent was busy could be executed in the wrong user's project
   * and its reply delivered to the wrong chat. Every read and every take is scoped to one
   * account for that reason.
   */
  userId: number | null;
}

export interface QueuedPromptInput extends IncomingPrompt {
  displayText?: string;
  responseMode?: "text_only" | "text_and_tts";
  /** Raw media bytes from Telegram file_size metadata, before base64 encoding. */
  mediaBytes?: number;
}

/**
 * Prompt Queue - holds prepared user prompts received while the session is busy.
 * Kept in memory only: queued messages must not survive a restart and leak into
 * a different session context.
 * Singleton pattern
 */
class PromptQueueManager {
  private items: QueuedPrompt[] = [];
  private nextId = 1;
  private queuedMediaBytes = 0;

  add(input: QueuedPromptInput, userId: number | null = null): QueuedPrompt | null {
    const normalizedText = input.text.trim();
    const displayText = (input.displayText ?? (normalizedText || "[Attachment]")).trim();
    const mediaBytes = input.mediaBytes ?? 0;
    if (
      (!normalizedText && input.fileParts.length === 0 && input.photos.length === 0) ||
      !displayText ||
      this.isFull(userId) ||
      !this.canAcceptMedia(mediaBytes)
    ) {
      return null;
    }

    const item: QueuedPrompt = {
      id: `queued-${this.nextId++}`,
      text: normalizedText,
      fileParts: [...input.fileParts],
      photos: [...input.photos],
      displayText,
      mediaBytes,
      userId,
      ...(input.responseMode ? { responseMode: input.responseMode } : {}),
    };
    this.items.push(item);
    this.queuedMediaBytes += mediaBytes;
    logger.debug(`[PromptQueue] Prompt queued: id=${item.id}, size=${this.items.length}`);
    return item;
  }

  /** The queued prompts belonging to one account, in the order they were sent. */
  list(userId: number | null): QueuedPrompt[] {
    return this.items.filter((item) => item.userId === userId).map(copyQueuedPrompt);
  }

  removeById(id: string, userId: number | null): QueuedPrompt | null {
    const index = this.items.findIndex((item) => item.id === id && item.userId === userId);
    if (index < 0) {
      return null;
    }

    const [removed] = this.items.splice(index, 1);
    if (!removed) {
      return null;
    }
    this.queuedMediaBytes -= removed.mediaBytes;
    logger.debug(
      `[PromptQueue] Prompt removed: id=${removed.id}, position=${index + 1}, size=${this.items.length}`,
    );
    return removed;
  }

  /**
   * The oldest queued prompt belonging to one account. Scoped so that finishing one user's
   * run never dispatches another user's prompt into this session.
   */
  takeNext(userId: number | null): QueuedPrompt | null {
    const index = this.items.findIndex((item) => item.userId === userId);
    if (index < 0) {
      return null;
    }
    const item = this.items.splice(index, 1)[0] ?? null;
    if (item) {
      this.queuedMediaBytes -= item.mediaBytes;
      logger.debug(`[PromptQueue] Prompt taken: id=${item.id}, size=${this.items.length}`);
    }
    return item;
  }

  size(userId: number | null): number {
    return this.items.filter((item) => item.userId === userId).length;
  }

  isFull(userId: number | null): boolean {
    return this.size(userId) >= MAX_QUEUED_PROMPTS;
  }

  canAcceptMedia(mediaBytes: number): boolean {
    return mediaBytes >= 0 && this.queuedMediaBytes + mediaBytes <= MAX_QUEUED_MEDIA_BYTES;
  }

  mediaSize(): number {
    return this.queuedMediaBytes;
  }

  clear(reason: string): void {
    if (this.items.length === 0) {
      return;
    }

    logger.info(`[PromptQueue] Cleared queue: reason=${reason}, count=${this.items.length}`);
    this.items = [];
    this.queuedMediaBytes = 0;
  }

  __resetForTests(): void {
    this.items = [];
    this.nextId = 1;
    this.queuedMediaBytes = 0;
  }
}

export const promptQueue = new PromptQueueManager();

function copyQueuedPrompt(item: QueuedPrompt): QueuedPrompt {
  return {
    ...item,
    fileParts: [...item.fileParts],
    photos: [...item.photos],
  };
}
