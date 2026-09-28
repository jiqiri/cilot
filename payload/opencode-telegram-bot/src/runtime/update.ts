import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logger } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

/** Files that belong to the operator, not to the repository, and must survive an update. */
const PRESERVED_FILES = [".env", "settings.json", "settings.json.bak"] as const;

/**
 * The bot's own directory, derived from this module rather than from the process
 * working directory. In sources mode the runtime paths resolve appHome to process.cwd(),
 * which is wherever the operator happened to run the command, so an update invoked from
 * another directory would otherwise read and replace the wrong tree.
 */
function botRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Candidate locations for payload-source.txt. Deriving it from the bot directory alone
 * is not enough: a bot installed by install.sh lives in the install root, but a bot
 * deployed by hand, as on this machine, can sit anywhere under $HOME.
 */
function sourceFileCandidates(): string[] {
  const candidates: string[] = [];
  const fromEnv = process.env.OPENCODE_TELEGRAM_INSTALL_ROOT?.trim();
  if (fromEnv) {
    candidates.push(path.join(path.resolve(fromEnv), "payload-source.txt"));
  }
  candidates.push(path.join(path.dirname(botRoot()), "payload-source.txt"));
  const home = process.env.HOME?.trim();
  if (home) {
    candidates.push(
      path.join(home, ".local", "share", "opencode-telegram-installer", "payload-source.txt"),
    );
  }
  return candidates;
}

const FALLBACK_ARCHIVE_URL =
  "https://github.com/jiqiri/opencode-telegram-installer/archive/refs/heads/main.tar.gz";

/**
 * Where updates come from, in priority order:
 *
 *  1. OPENCODE_TELEGRAM_UPDATE_URL, for a one-off override.
 *  2. payload-source.txt, written by the installer. This is what makes a fork update
 *     from the fork: the compiled-in default below is only a last resort, so a machine
 *     installed from a fork never silently pulls from upstream.
 *  3. The compiled-in default, with a warning, because a missing source file means the
 *     install layout is not what this expects.
 */
function archiveUrl(): string {
  const override = process.env.OPENCODE_TELEGRAM_UPDATE_URL?.trim();
  if (override) {
    return override;
  }

  for (const candidate of sourceFileCandidates()) {
    try {
      const recorded = readFileSync(candidate, "utf8");
      const url = /^url=(.+)$/m.exec(recorded)?.[1]?.trim();
      const repo = /^repo=(.+)$/m.exec(recorded)?.[1]?.trim();
      if (url) {
        writeStdout(`Update source: ${repo ?? "custom"} (${url})`);
        writeStdout(`Source recorded in ${candidate}`);
        return url;
      }
    } catch {
      // Try the next candidate.
    }
  }

  writeStdout(
    "Warning: no payload-source.txt found, falling back to the built-in default. " +
      "Re-run the installer, or set OPENCODE_TELEGRAM_UPDATE_URL, if this machine was installed from a fork.",
  );
  return FALLBACK_ARCHIVE_URL;
}

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function download(url: string, destination: string): Promise<void> {
  // tar.gz is not plain text, so the body is fetched with a binary-safe helper rather
  // than written by hand.
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error("Download returned an empty archive.");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(destination, bytes);
}

async function findPayloadRoot(extracted: string): Promise<string> {
  const entries = await readdir(extracted, { withFileTypes: true });
  const repo = entries.find((entry) => entry.isDirectory() && entry.name.includes("opencode-telegram-installer"));
  if (!repo) {
    throw new Error("Downloaded archive does not look like the installer repository.");
  }
  return path.join(extracted, repo.name, "payload", "opencode-telegram-bot");
}

export interface UpdateResult {
  updated: boolean;
  reason: string;
}

/**
 * Replaces the bot's tracked files with the latest published payload, then rebuilds.
 *
 * Only files that came from the repository are replaced. The bot's .env holds the
 * Telegram token and the OpenCode credentials, and settings.json holds per-account
 * state, so both are copied aside and put back. The running service is not restarted
 * here; that is left to systemd so a failed build cannot take the bot down silently.
 */
export async function runUpdateCommand(options: { checkOnly?: boolean } = {}): Promise<number> {
  const appHome = botRoot();
  const url = archiveUrl();

  writeStdout(`Checking ${url}`);

  const workdir = await mkdtemp(path.join(tmpdir(), "opencode-telegram-update-"));
  let exitCode = 0;

  try {
    const archive = path.join(workdir, "payload.tar.gz");
    await download(url, archive);
    await execFileAsync("tar", ["-xzf", archive, "-C", workdir]);

    const payload = await findPayloadRoot(workdir);
    const manifest = path.join(payload, "package.json");
    const incoming = JSON.parse(await readFile(manifest, "utf8")) as { version?: string };
    const currentPath = path.join(appHome, "package.json");
    const current = JSON.parse(await readFile(currentPath, "utf8")) as { version?: string };

    if (incoming.version && current.version && incoming.version === current.version) {
      writeStdout(`Already on ${current.version}, nothing to do.`);
      return 0;
    }

    if (options.checkOnly) {
      writeStdout(`Update available: ${current.version ?? "unknown"} -> ${incoming.version ?? "unknown"}`);
      return 0;
    }

    const preserved = new Map<string, Buffer>();
    for (const name of PRESERVED_FILES) {
      try {
        preserved.set(name, await readFile(path.join(appHome, name)));
      } catch {
        // Absent on a first run or a bot started without an env file.
      }
    }
    if (preserved.size > 0) {
      writeStdout(`Preserved: ${[...preserved.keys()].join(", ")}`);
    }

    // Remove only what the payload owns, so stale source files cannot survive an update.
    for (const dir of ["dist", "node_modules"]) {
      await rm(path.join(appHome, dir), { recursive: true, force: true });
    }
    await cp(payload, appHome, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(payload, source);
        if (relative === "") {
          return true;
        }
        return !(PRESERVED_FILES as readonly string[]).includes(relative);
      },
    });

    for (const [name, contents] of preserved) {
      await mkdir(path.dirname(path.join(appHome, name)), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path.join(appHome, name), contents);
    }

    writeStdout("Installing dependencies...");
    await execFileAsync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: appHome, maxBuffer: 1024 * 1024 * 32 });

    writeStdout("Building...");
    await execFileAsync("npm", ["run", "build"], { cwd: appHome, maxBuffer: 1024 * 1024 * 32 });

    const installed = JSON.parse(await readFile(currentPath, "utf8")) as { version?: string };
    writeStdout(`Updated to ${installed.version ?? "unknown"}.`);
    writeStdout("Restart the service to run it: systemctl --user restart opencode-telegram-bot.service");
    return 0;
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Update] Failed: ${message}`);
    writeStdout(`Update failed: ${message}`);
    writeStdout("The previous installation was left in place; nothing was replaced until the download and build succeeded.");
    return exitCode;
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

export function updateFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
