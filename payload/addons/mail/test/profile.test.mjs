import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  defaultProfile,
  loadProfile,
  requireReadableScope,
  validateProfile,
} from "../dist/shared/profile.js";

/**
 * The manifest is the schema, and a saved value that violates it is an error rather than a
 * silent default. These cases pin that down for each field type.
 */

const manifest = {
  id: "mail",
  name: "Mail",
  version: "1.0.0",
  entry: "dist/server.js",
  scope: "per-user",
  tools: [{ name: "search" }],
  config: {
    mode: { type: "enum", values: ["labels", "mailbox"], default: "labels" },
    labels: { type: "string[]", default: [] },
    folders: { type: "string[]", default: ["INBOX"] },
    maxResults: { type: "number", min: 1, max: 100, default: 20 },
  },
};

let addonRoot = "";
let configRoot = "";

function writeProfile(accountId, profile) {
  const directory = path.join(configRoot, "users", accountId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "config.json"), JSON.stringify(profile));
}

beforeEach(() => {
  addonRoot = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-profile-root-"));
  configRoot = mkdtempSync(path.join(os.tmpdir(), "cilot-addon-profile-config-"));
  writeFileSync(
    path.join(addonRoot, "default-config.json"),
    JSON.stringify({ mode: "labels", labels: [], folders: ["INBOX"], maxResults: 20 }),
  );
});

afterEach(() => {
  rmSync(addonRoot, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

describe("shared/profile", () => {
  it("seeds a profile from default-config.json", () => {
    const profile = defaultProfile(manifest, addonRoot);
    assert.deepEqual(profile, {
      mode: "labels",
      labels: [],
      folders: ["INBOX"],
      maxResults: 20,
    });
  });

  it("keeps keys the manifest does not know about", () => {
    writeFileSync(
      path.join(addonRoot, "default-config.json"),
      JSON.stringify({ mode: "mailbox", futureKey: "kept" }),
    );
    assert.equal(defaultProfile(manifest, addonRoot).futureKey, "kept");
  });

  it("merges a saved profile over the defaults", () => {
    writeProfile("42", { folders: ["Archive"], maxResults: 5 });
    assert.deepEqual(loadProfile(manifest, addonRoot, configRoot, "42"), {
      mode: "labels",
      labels: [],
      folders: ["Archive"],
      maxResults: 5,
    });
  });

  it("refuses an out-of-range number instead of clamping it", () => {
    writeProfile("42", { maxResults: 500 });
    assert.throws(() => loadProfile(manifest, addonRoot, configRoot, "42"), (error) => {
      assert.equal(error.code, "invalid_config");
      assert.match(error.message, /maxResults/);
      return true;
    });
  });

  it("refuses a value of the wrong type", () => {
    writeProfile("42", { folders: "INBOX" });
    assert.throws(
      () => loadProfile(manifest, addonRoot, configRoot, "42"),
      (error) => error.code === "invalid_config",
    );
  });

  it("reports a broken config file as invalid_config", () => {
    const directory = path.join(configRoot, "users", "42");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "config.json"), "{");
    assert.throws(
      () => loadProfile(manifest, addonRoot, configRoot, "42"),
      (error) => error.code === "invalid_config",
    );
  });

  it("validates an enum against its declared values", () => {
    assert.throws(
      () => validateProfile(manifest, { mode: "everything" }),
      (error) => error.code === "invalid_config",
    );
  });

  it("rejects labels mode with no labels and no folders", () => {
    assert.throws(
      () => requireReadableScope({ mode: "labels", labels: [], folders: [] }),
      (error) => error.code === "not_configured",
    );
  });

  it("accepts labels mode when a folder is configured", () => {
    assert.doesNotThrow(() => requireReadableScope({ mode: "labels", labels: [], folders: ["INBOX"] }));
  });

  it("does not require a scope in mailbox mode", () => {
    assert.doesNotThrow(() => requireReadableScope({ mode: "mailbox" }));
  });
});
