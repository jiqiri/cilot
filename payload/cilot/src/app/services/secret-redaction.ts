import fs from "node:fs";
import { logger } from "../../utils/logger.js";
import { resolveVaultPaths } from "./vault-paths.js";

/**
 * Last line of defence for credentials that were never meant to leave the machine.
 *
 * The bot is not the place that decides whether an agent *can* reach a key — that is the
 * sandbox and the agent's tool permissions. This module exists for the case where a key
 * still ends up in an assistant message: the model repeats a value a tool printed, a user
 * pastes one into the chat, or a provider echoes its own token in an error. Outgoing text
 * is rewritten before Telegram sees it, so "ask the agent to print the key" cannot succeed
 * even if the model tries.
 *
 * Two sources feed the match set:
 *
 *   - the vault, whose values are matched exactly (and in base64/hex form, because an agent
 *     that already leaked a value often leaks an encoded copy of it),
 *   - well-known provider token shapes, which catch keys that never passed through the vault
 *     (the LLM key lives in the server's env file, not in the bot's).
 *
 * Nothing here logs a matched value: only the rule name and the count.
 */

export const REDACTED = "[redacted]";

/** Short values collide with ordinary words, so the exact-match set ignores them. */
const MIN_EXACT_LENGTH = 12;
const CACHE_TTL_MS = 5_000;

interface PatternRule {
  name: string;
  pattern: RegExp;
}

/**
 * Provider shapes worth matching even when the value is not in the vault.
 *
 * These are deliberately anchored on vendor prefixes rather than on entropy: a generic
 * "long random string" rule would redact commit hashes and IDs the operator needs to see.
 */
const PATTERN_RULES: PatternRule[] = [
  { name: "openrouter", pattern: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g },
  { name: "openai", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g },
  { name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "telegram_bot_token", pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { name: "stripe_key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  {
    name: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

interface CachedValues {
  readAt: number;
  values: string[];
}

let cache: CachedValues | null = null;

/** Test hook: forces the next call to re-read the vault. */
export function resetSecretRedactionCache(): void {
  cache = null;
}

function readVaultValuesSync(): string[] {
  const { storeFile } = resolveVaultPaths();

  let raw: string;
  try {
    raw = fs.readFileSync(storeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`[Redaction] Could not read the secret store: ${(error as Error).message}`);
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The store's own reader refuses a corrupt file. Redaction degrades to patterns rather
    // than throwing on the send path, where a failure would drop the assistant's answer.
    logger.warn("[Redaction] Secret store is not valid JSON; falling back to patterns");
    return [];
  }

  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];

  const values: string[] = [];
  for (const entry of entries) {
    const value = (entry as { value?: unknown }).value;
    if (typeof value === "string" && value.length >= MIN_EXACT_LENGTH) {
      values.push(value);
    }
  }
  return values;
}

/**
 * Encoded copies of a known value, so redaction survives "repeat it in base64".
 *
 * Only the standard padded base64 form and lowercase hex are covered; anything more creative
 * is a job for the sandbox, not for a string filter.
 */
function encodedForms(value: string): string[] {
  const buffer = Buffer.from(value, "utf8");
  const forms = [buffer.toString("base64"), buffer.toString("hex")];
  return forms.filter((form) => form.length >= MIN_EXACT_LENGTH);
}

function knownValues(): string[] {
  const now = Date.now();
  if (cache && now - cache.readAt < CACHE_TTL_MS) {
    return cache.values;
  }

  const values = readVaultValuesSync();
  const expanded = [...values];
  for (const value of values) {
    expanded.push(...encodedForms(value));
  }

  cache = { readAt: now, values: expanded };
  return expanded;
}

function redactExact(text: string, values: string[]): { text: string; count: number } {
  let result = text;
  let count = 0;

  for (const value of values) {
    if (!result.includes(value)) continue;
    count += result.split(value).length - 1;
    result = result.split(value).join(REDACTED);
  }

  return { text: result, count };
}

function redactPatterns(text: string): { text: string; count: number; rules: string[] } {
  let result = text;
  let count = 0;
  const rules: string[] = [];

  for (const rule of PATTERN_RULES) {
    // `lastIndex` is state on a global regex; resetting keeps repeated calls deterministic.
    rule.pattern.lastIndex = 0;
    let matches = 0;
    result = result.replace(rule.pattern, () => {
      matches += 1;
      return REDACTED;
    });
    rule.pattern.lastIndex = 0;

    if (matches > 0) {
      count += matches;
      rules.push(rule.name);
    }
  }

  return { text: result, count, rules };
}

/**
 * Rewrites every credential-shaped substring in `text`.
 *
 * Safe to call on arbitrary assistant output: ordinary prose, commit hashes and short IDs
 * are left alone, and the function never throws on a store read failure.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  const exact = redactExact(text, knownValues());
  const patterned = redactPatterns(exact.text);
  const count = exact.count + patterned.count;

  if (count > 0) {
    logger.warn("[Redaction] Removed credential material from outgoing text", {
      count,
      rules: patterned.rules,
      exactMatches: exact.count,
    });
  }

  return patterned.text;
}

/** Whether `text` still contains a credential after redaction. Used by tests and callers. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
