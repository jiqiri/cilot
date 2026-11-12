import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authenticatedArchiveUrl, githubToken } from "../src/runtime/update.js";

/**
 * The repository these installs update from can be private. Anonymous requests to
 * `github.com/OWNER/REPO/archive/...` answer 404 for a private repo and never look at a
 * credential, so the updater has to rewrite the URL to a host that accepts a token and
 * send it there. These tests pin that rewrite and the token lookup, because getting
 * either wrong turns every update into a 404 with no useful explanation.
 */
describe("archive URL rewriting", () => {
  it("rewrites a branch archive URL to codeload", () => {
    expect(
      authenticatedArchiveUrl(
        "https://github.com/jiqiri/cilot/archive/refs/heads/main.tar.gz",
      ),
    ).toBe("https://codeload.github.com/jiqiri/cilot/tar.gz/refs/heads/main");
  });

  it("rewrites a tag archive URL to codeload", () => {
    expect(
      authenticatedArchiveUrl("https://github.com/owner/repo/archive/refs/tags/v0.26.1.tar.gz"),
    ).toBe("https://codeload.github.com/owner/repo/tar.gz/refs/tags/v0.26.1");
  });

  it("keeps a ref containing slashes intact", () => {
    expect(
      authenticatedArchiveUrl("https://github.com/owner/repo/archive/refs/heads/release/0.26.tar.gz"),
    ).toBe("https://codeload.github.com/owner/repo/tar.gz/refs/heads/release/0.26");
  });

  it("leaves a URL it does not recognise alone", () => {
    for (const url of [
      "https://codeload.github.com/owner/repo/tar.gz/refs/heads/main",
      "https://api.github.com/repos/owner/repo/tarball/main",
      "https://example.com/payload.tar.gz",
      "file:///srv/payload.tar.gz",
    ]) {
      expect(authenticatedArchiveUrl(url)).toBe(url);
    }
  });

  it("is not confused by an owner or repo that looks like a path", () => {
    expect(
      authenticatedArchiveUrl("https://github.com/my-org/my.repo/archive/refs/heads/main.tar.gz"),
    ).toBe("https://codeload.github.com/my-org/my.repo/tar.gz/refs/heads/main");
  });
});

describe("token lookup", () => {
  let home: string;
  let installRoot: string;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "update-token-home-"));
    installRoot = await fs.mkdtemp(path.join(os.tmpdir(), "update-token-root-"));
  });

  afterAll(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(installRoot, { recursive: true, force: true });
  });

  it("prefers an explicit environment variable", () => {
    expect(
      githubToken({ HOME: home, CILOT_GITHUB_TOKEN: "explicit-token" }),
    ).toBe("explicit-token");
  });

  it("falls back to GITHUB_TOKEN", () => {
    expect(githubToken({ HOME: home, GITHUB_TOKEN: "generic-token" })).toBe("generic-token");
  });

  it("reads the install root token file before the credential store", async () => {
    await fs.writeFile(path.join(installRoot, "github-token"), "file-token\n", { mode: 0o600 });
    expect(githubToken({ HOME: home, CILOT_INSTALL_ROOT: installRoot })).toBe(
      "file-token",
    );
    await fs.rm(path.join(installRoot, "github-token"));
  });

  it("reads the credential store git itself uses", async () => {
    await fs.writeFile(
      path.join(home, ".git-credentials"),
      "https://x-access-token:store-token@github.com\n",
      { mode: 0o600 },
    );
    expect(githubToken({ HOME: home })).toBe("store-token");
  });

  it("decodes a URL-encoded credential", async () => {
    await fs.writeFile(
      path.join(home, ".git-credentials"),
      "https://x-access-token:tok%2Fwith%2Bchars@github.com\n",
      { mode: 0o600 },
    );
    expect(githubToken({ HOME: home })).toBe("tok/with+chars");
  });

  it("ignores a credential for another host", async () => {
    await fs.writeFile(
      path.join(home, ".git-credentials"),
      "https://user:gitlab-token@gitlab.com\n",
      { mode: 0o600 },
    );
    expect(githubToken({ HOME: home })).toBeUndefined();
  });

  it("returns undefined when there is no token anywhere", async () => {
    await fs.rm(path.join(home, ".git-credentials"), { force: true });
    expect(githubToken({ HOME: home })).toBeUndefined();
  });

  it("never treats an empty environment variable as a token", () => {
    expect(githubToken({ HOME: home, GITHUB_TOKEN: "   " })).toBeUndefined();
  });
});
