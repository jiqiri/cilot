import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveAccount } from "../dist/shared/identity.js";

/**
 * The account is the workspace, so these cases are the whole authorization boundary:
 * a path under the user root names one id, and everything else names nobody.
 */

let root = "";

function expectUnknownAccount(run) {
  assert.throws(run, (error) => {
    assert.equal(error.code, "unknown_account");
    return true;
  });
}

beforeEach(() => {
  const base = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-identity-"));
  root = path.join(base, "users");
  mkdirSync(path.join(root, "42", "projects"), { recursive: true });
  mkdirSync(path.join(root, "shared-team"), { recursive: true });
  process.env.CILOT_USER_ROOT = root;
});

afterEach(() => {
  delete process.env.CILOT_USER_ROOT;
  rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("shared/identity", () => {
  it("returns no account for a global add-on", () => {
    assert.deepEqual(resolveAccount("global", "/"), { id: null });
  });

  it("reads the first path segment as the Telegram id", () => {
    assert.deepEqual(resolveAccount("per-user", path.join(root, "42")), { id: "42" });
    assert.deepEqual(resolveAccount("per-user", path.join(root, "42", "projects")), {
      id: "42",
    });
  });

  it("refuses a directory that is not inside a personal workspace", () => {
    expectUnknownAccount(() => resolveAccount("per-user", os.tmpdir()));
  });

  it("refuses the user root itself", () => {
    expectUnknownAccount(() => resolveAccount("per-user", root));
  });

  it("refuses a shared folder, which has no single owner", () => {
    const shared = path.join(path.dirname(root), "shared", "team");
    mkdirSync(shared, { recursive: true });
    expectUnknownAccount(() => resolveAccount("per-user", shared));
  });

  it("refuses a non-numeric first segment", () => {
    expectUnknownAccount(() => resolveAccount("per-user", path.join(root, "shared-team")));
  });

  it("follows a symlink into a workspace only when it resolves inside the root", () => {
    const link = path.join(os.tmpdir(), `cilot-identity-link-${process.pid}`);
    rmSync(link, { force: true });
    symlinkSync(path.join(root, "42"), link);
    try {
      assert.deepEqual(resolveAccount("per-user", link), { id: "42" });
    } finally {
      rmSync(link, { force: true });
    }
  });
});
