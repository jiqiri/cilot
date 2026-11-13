import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { acknowledge, readCursor } from "../dist/mail/cursor.js";

/**
 * The cursor is what turns "list the unread messages" into "tell me what is new". It is
 * per account, deduplicated and bounded, so a scheduled task cannot grow it forever.
 */

let stateRoot = "";

beforeEach(() => {
  stateRoot = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-cursor-"));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

describe("mail/cursor", () => {
  it("starts empty", () => {
    assert.deepEqual(readCursor(stateRoot, "42"), { seenIds: [] });
  });

  it("records ids and a timestamp", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const result = acknowledge(stateRoot, "42", ["a", "b"], now);
    assert.deepEqual(result, { added: 2, seen: 2 });
    const cursor = readCursor(stateRoot, "42");
    assert.equal(cursor.lastSeen, now.toISOString());
    assert.deepEqual(cursor.seenIds, ["a", "b"]);
  });

  it("counts only ids it has not seen before", () => {
    acknowledge(stateRoot, "42", ["a", "b"]);
    assert.deepEqual(acknowledge(stateRoot, "42", ["b", "c"]), { added: 1, seen: 3 });
  });

  it("keeps accounts apart", () => {
    acknowledge(stateRoot, "42", ["a"]);
    assert.deepEqual(readCursor(stateRoot, "43").seenIds, []);
  });

  it("is bounded to the most recent 500 ids", () => {
    const ids = Array.from({ length: 520 }, (_, index) => `id-${index}`);
    const result = acknowledge(stateRoot, "42", ids);
    assert.equal(result.seen, 500);
    const cursor = readCursor(stateRoot, "42");
    assert.equal(cursor.seenIds[0], "id-20");
    assert.equal(cursor.seenIds.at(-1), "id-519");
  });

  it("ignores blank ids", () => {
    assert.deepEqual(acknowledge(stateRoot, "42", ["", "  "]), { added: 0, seen: 0 });
  });

  it("returns an empty cursor for an unreadable file", () => {
    assert.deepEqual(readCursor(stateRoot, "missing"), { seenIds: [] });
  });
});
