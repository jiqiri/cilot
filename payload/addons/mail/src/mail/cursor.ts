import fs from "node:fs";
import path from "node:path";
import { log } from "../shared/errors.js";

/**
 * The notification cursor, written by `mail_ack` and never by IMAP.
 *
 * `seenIds` is bounded so the file cannot grow without limit; 500 ids is months of a
 * sane notification task and still tiny. The cursor is per account and per add-on, so two
 * accounts never acknowledge each other's mail.
 */

export interface Cursor {
  lastSeen?: string;
  seenIds: string[];
}

const MAX_SEEN = 500;

export function readCursor(stateRoot: string, accountId: string): Cursor {
  const file = path.join(stateRoot, "users", accountId, "cursor.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Cursor>;
    return {
      ...(typeof parsed.lastSeen === "string" ? { lastSeen: parsed.lastSeen } : {}),
      seenIds: Array.isArray(parsed.seenIds)
        ? parsed.seenIds.filter((entry): entry is string => typeof entry === "string")
        : [],
    };
  } catch {
    return { seenIds: [] };
  }
}

export function writeCursor(stateRoot: string, accountId: string, cursor: Cursor): void {
  const directory = path.join(stateRoot, "users", accountId);
  const file = path.join(directory, "cursor.json");
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort.
    }
    log(`cursor write failed: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
}

export function acknowledge(
  stateRoot: string,
  accountId: string,
  messageIds: string[],
  now = new Date(),
): { added: number; seen: number } {
  const cursor = readCursor(stateRoot, accountId);
  const known = new Set(cursor.seenIds);
  let added = 0;
  for (const id of messageIds) {
    const trimmed = id.trim();
    if (!trimmed || known.has(trimmed)) continue;
    known.add(trimmed);
    added += 1;
  }
  const seenIds = [...known].slice(-MAX_SEEN);
  writeCursor(stateRoot, accountId, {
    lastSeen: now.toISOString(),
    seenIds,
  });
  return { added, seen: seenIds.length };
}
