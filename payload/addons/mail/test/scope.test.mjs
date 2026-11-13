import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  configuredScope,
  defaultMailbox,
  isLabelsMode,
  labelScopeTargets,
  mailboxTargets,
  readTarget,
} from "../dist/mail/scope.js";

/**
 * In labels mode the configured set is the whole world: naming a label the admin did not
 * grant is an authorization failure, not a lookup that happens to succeed. In mailbox mode
 * any folder the server lists is allowed. That difference is what these cases pin down.
 */

const folders = [
  { path: "INBOX", name: "INBOX", delimiter: "/" },
  { path: "Archive", name: "Archive", delimiter: "/" },
  { path: "Receipts", name: "Receipts", delimiter: "/" },
];

describe("mail/scope", () => {
  it("treats a profile as labels mode unless it says mailbox", () => {
    assert.equal(isLabelsMode({ mode: "labels" }), true);
    assert.equal(isLabelsMode({}), true);
    assert.equal(isLabelsMode({ mode: "mailbox" }), false);
  });

  it("combines labels and folders into one scope, without duplicates", () => {
    assert.deepEqual(
      configuredScope({ labels: ["Receipts", "Receipts"], folders: ["INBOX"] }),
      ["Receipts", "INBOX"],
    );
  });

  it("ignores empty and non-string entries", () => {
    assert.deepEqual(configuredScope({ labels: ["", "  ", 3], folders: ["INBOX"] }), ["INBOX"]);
  });

  it("returns every configured target when no label is named", () => {
    assert.deepEqual(
      labelScopeTargets({ mode: "labels", labels: ["Receipts"], folders: ["INBOX"] }),
      ["Receipts", "INBOX"],
    );
  });

  it("refuses a label outside the configured scope", () => {
    assert.throws(
      () => labelScopeTargets({ mode: "labels", labels: ["Receipts"], folders: [] }, "Archive"),
      (error) => error.code === "invalid_config",
    );
  });

  it("refuses a call that names both a label and a folder", () => {
    assert.throws(
      () => labelScopeTargets({ labels: ["Receipts"] }, "Receipts", "INBOX"),
      (error) => error.code === "invalid_config",
    );
  });

  it("refuses an empty labels-mode scope", () => {
    assert.throws(
      () => labelScopeTargets({ mode: "labels", labels: [], folders: [] }),
      (error) => error.code === "not_configured",
    );
  });

  it("allows any listed folder in mailbox mode", () => {
    const profile = { mode: "mailbox", folders: ["INBOX"] };
    assert.deepEqual(mailboxTargets(profile, folders, undefined, "Archive"), ["Archive"]);
    assert.deepEqual(mailboxTargets(profile, folders), ["INBOX"]);
  });

  it("refuses a folder the server does not list in mailbox mode", () => {
    assert.throws(
      () => mailboxTargets({ mode: "mailbox" }, folders, undefined, "Missing"),
      (error) => error.code === "invalid_config",
    );
  });

  it("distinguishes an out-of-scope read from a config mistake", () => {
    assert.throws(
      () => readTarget({ mode: "labels", labels: ["Receipts"] }, folders, undefined, "Archive"),
      (error) => error.code === "not_granted",
    );
    assert.equal(
      readTarget({ mode: "mailbox" }, folders, undefined, "Archive"),
      "Archive",
    );
  });

  it("falls back to INBOX when nothing is configured", () => {
    assert.equal(defaultMailbox({ mode: "mailbox" }), "INBOX");
  });
});
