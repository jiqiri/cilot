import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { grantFor, readPolicy, requireGrant } from "../dist/shared/policy.js";

/**
 * `policy.json` is re-read on every call and fails closed, so the cases here are about a
 * missing file, a broken file and the two defaults rather than about caching.
 */

let configRoot = "";

function writePolicy(value) {
  writeFileSync(path.join(configRoot, "policy.json"), JSON.stringify(value));
}

beforeEach(() => {
  configRoot = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-policy-"));
});

afterEach(() => {
  rmSync(configRoot, { recursive: true, force: true });
});

describe("shared/policy", () => {
  it("defaults to admin-only, so an id with no row is off", () => {
    const policy = readPolicy(configRoot);
    assert.equal(policy.default, "admin-only");
    assert.equal(grantFor(policy, "42"), "off");
    assert.throws(() => requireGrant(configRoot, "42"), (error) => {
      assert.equal(error.code, "not_granted");
      return true;
    });
  });

  it("honours an explicit use grant", () => {
    writePolicy({ version: 1, default: "admin-only", users: { 42: { grant: "use" } } });
    assert.equal(requireGrant(configRoot, "42"), "use");
    assert.equal(grantFor(readPolicy(configRoot), "43"), "off");
  });

  it("honours an explicit off row even when the default is all-users", () => {
    writePolicy({ version: 1, default: "all-users", users: { 42: { grant: "off" } } });
    const policy = readPolicy(configRoot);
    assert.equal(grantFor(policy, "42"), "off");
    assert.equal(grantFor(policy, "43"), "use");
  });

  it("treats an unknown grant value as off rather than as use", () => {
    writePolicy({ version: 1, default: "admin-only", users: { 42: { grant: "admin" } } });
    assert.equal(grantFor(readPolicy(configRoot), "42"), "off");
  });

  it("fails closed on malformed JSON", () => {
    writeFileSync(path.join(configRoot, "policy.json"), "{ not json");
    assert.equal(grantFor(readPolicy(configRoot), "42"), "off");
  });

  it("fails closed on a non-object document", () => {
    writeFileSync(path.join(configRoot, "policy.json"), "[]");
    assert.equal(grantFor(readPolicy(configRoot), "42"), "off");
  });

  it("grants nothing to a global add-on, which has no per-account row", () => {
    writePolicy({ version: 1, default: "all-users", users: {} });
    assert.equal(grantFor(readPolicy(configRoot), null), "off");
  });
});
