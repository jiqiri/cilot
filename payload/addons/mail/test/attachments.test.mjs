import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  safeAttachmentName,
  safeDirectoryName,
  saveAttachments,
} from "../dist/mail/attachments.js";

/**
 * Attachments are the only write path in a read-only add-on, so the cases here are the four
 * rules from the module header: sanitised names, a confined directory, no overwrite, and
 * size limits.
 */

let workspace = "";

function part(overrides = {}) {
  const buffer = overrides.buffer ?? Buffer.from("hello");
  return {
    info: {
      part: "2",
      filename: "report.pdf",
      mime: "application/pdf",
      size: buffer.length,
      inline: false,
      ...overrides.info,
    },
    buffer,
    truncated: overrides.truncated ?? false,
  };
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-attachments-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("mail/attachments", () => {
  it("reduces a path to a bare file name", () => {
    assert.equal(safeAttachmentName("../../etc/passwd", "fallback"), "passwd");
    assert.equal(safeAttachmentName("..\\..\\win.ini", "fallback"), "win.ini");
    assert.equal(safeAttachmentName("..", "fallback"), "fallback");
    assert.equal(safeAttachmentName("", "attachment-2"), "attachment-2");
  });

  it("strips characters that a file name cannot keep", () => {
    assert.equal(safeAttachmentName('in"voice<1>.pdf', "fallback"), "in_voice_1_.pdf");
  });

  it("shortens an absurdly long name", () => {
    assert.equal(safeAttachmentName("a".repeat(400), "fallback").length, 120);
  });

  it("sanitises the message-directory name", () => {
    assert.equal(safeDirectoryName("<id@example.com>"), "id_example.com");
    assert.equal(safeDirectoryName(""), "message");
    const traversal = safeDirectoryName("../../etc");
    assert.doesNotMatch(traversal, /[\\/]/);
    assert.equal(traversal.startsWith("."), false);
  });

  it("writes the file inside the workspace with owner-only permissions", async () => {
    const outcome = await saveAttachments(workspace, "<id@example.com>", [part()], {
      attachmentMaxMB: 10,
    });

    assert.equal(outcome.saved.length, 1);
    const saved = outcome.saved[0];
    assert.equal(saved.name, "report.pdf");
    assert.equal(path.dirname(saved.path), path.join(workspace, "mail-attachments", "id_example.com"));
    assert.equal(readFileSync(saved.path, "utf8"), "hello");
    assert.equal(statSync(saved.path).mode & 0o777, 0o600);
  });

  it("never overwrites: a second copy gets a suffix", async () => {
    await saveAttachments(workspace, "m1", [part()], { attachmentMaxMB: 10 });
    const second = await saveAttachments(workspace, "m1", [part()], { attachmentMaxMB: 10 });
    assert.equal(second.saved[0].name, "report-1.pdf");
  });

  it("skips a part over the per-part limit", async () => {
    const outcome = await saveAttachments(
      workspace,
      "m1",
      [part({ buffer: Buffer.alloc(2 * 1024 * 1024), info: { size: 2 * 1024 * 1024 } })],
      { attachmentMaxMB: 1 },
    );
    assert.equal(outcome.saved.length, 0);
    assert.equal(outcome.skipped.length, 1);
    assert.equal(outcome.bytes, 0);
  });

  it("skips a part over the per-call total", async () => {
    const outcome = await saveAttachments(
      workspace,
      "m1",
      [part(), part({ info: { filename: "second.txt" } })],
      { attachmentMaxMB: 10, totalLimit: 6 },
    );
    assert.equal(outcome.saved.length, 1);
    assert.equal(outcome.skipped[0].name, "second.txt");
  });

  it("skips a truncated download even when its reported size looks small", async () => {
    const outcome = await saveAttachments(workspace, "m1", [part({ truncated: true })], {
      attachmentMaxMB: 10,
    });
    assert.equal(outcome.saved.length, 0);
  });

  it("refuses to follow a symlinked message directory out of the workspace", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-outside-"));
    mkdirSync(path.join(workspace, "mail-attachments"), { recursive: true });
    symlinkSync(outside, path.join(workspace, "mail-attachments", "m1"));
    try {
      await assert.rejects(
        () => saveAttachments(workspace, "m1", [part()], { attachmentMaxMB: 10 }),
        (error) => error.code === "upstream_error",
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("adds a data URI for a small image, and only for an image", async () => {
    const outcome = await saveAttachments(
      workspace,
      "m1",
      [
        part({ buffer: Buffer.from([0xff, 0xd8, 0xff]), info: { filename: "photo.jpg", mime: "image/jpeg", size: 3 } }),
        part({ info: { filename: "notes.txt", mime: "text/plain" } }),
      ],
      { attachmentMaxMB: 10 },
    );
    assert.match(outcome.saved[0].dataUri ?? "", /^data:image\/jpeg;base64,/);
    assert.equal(outcome.saved[1].dataUri, undefined);
  });

  it("reports a missing workspace as an upstream error", async () => {
    rmSync(workspace, { recursive: true, force: true });
    await assert.rejects(
      () => saveAttachments(workspace, "m1", [part()], { attachmentMaxMB: 10 }),
      (error) => error.code === "upstream_error",
    );
  });
});
