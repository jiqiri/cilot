import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  haveAllRequired,
  loadSecrets,
  parseSecrets,
  requireSecret,
  secretsPath,
} from "../dist/shared/secrets.js";

/**
 * The credential file is line-oriented and literal after the first `=`, so a `$` in an app
 * password has to survive unchanged and a value can never invent a second variable.
 */

describe("shared/secrets", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-secrets-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads values literally, including `$`, `#` and `=`", () => {
    const parsed = parseSecrets(
      [
        "# a comment",
        "MAIL_IMAP_USER=me@example.com",
        "MAIL_IMAP_PASSWORD=p$ss=word#1",
        "",
      ].join("\n"),
    );
    assert.deepEqual(parsed, {
      MAIL_IMAP_USER: "me@example.com",
      MAIL_IMAP_PASSWORD: "p$ss=word#1",
    });
  });

  it("rejects a line with no key", () => {
    assert.throws(() => parseSecrets("=value"), /no KEY=value pair/);
  });

  it("rejects a key that is not an environment variable name", () => {
    assert.throws(() => parseSecrets("mail-host=x"), /invalid key/);
  });

  it("puts a per-user file under users/<id> and a global file at the root", () => {
    assert.equal(
      secretsPath(root, "per-user", "42"),
      path.join(root, "users", "42", "secrets.env"),
    );
    assert.equal(secretsPath(root, "global", null), path.join(root, "secrets.env"));
  });

  it("reports a missing per-user file as not_configured", () => {
    assert.throws(
      () => loadSecrets(root, "per-user", "42"),
      (error) => error.code === "not_configured",
    );
  });

  it("loads a written file and names the missing key", () => {
    const directory = path.join(root, "users", "42");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "secrets.env"), "MAIL_IMAP_HOST=imap.example.com\n");

    const secrets = loadSecrets(root, "per-user", "42");
    assert.equal(secrets.MAIL_IMAP_HOST, "imap.example.com");
    assert.equal(haveAllRequired(secrets, ["MAIL_IMAP_HOST"]), true);
    assert.equal(haveAllRequired(secrets, ["MAIL_IMAP_HOST", "MAIL_IMAP_PASSWORD"]), false);
    assert.throws(
      () => requireSecret(secrets, "MAIL_IMAP_PASSWORD"),
      (error) => error.code === "missing_secret",
    );
  });
});
