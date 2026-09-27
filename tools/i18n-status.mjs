#!/usr/bin/env node
// Reports translation coverage per locale for the Telegram bot's i18n dictionaries.
//
// The type system already refuses to build when a locale is missing a key, so
// this script answers the other question a translator has: which keys are still
// sitting at the English value.
//
//   node tools/i18n-status.mjs              # summary for every locale
//   node tools/i18n-status.mjs --locale vi  # list untranslated keys for vi
//   node tools/i18n-status.mjs --locale vi --all  # include already-translated keys
//
// Dependency free on purpose: contributors should not need to install anything
// to see what is left to do.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = resolve(here, "..", "payload", "opencode-telegram-bot", "src", "i18n");
const SOURCE = "en";

/**
 * Dictionary entries are one key per line, but the value may sit on the line
 * below when the line would otherwise get too long, so match the key and then
 * the first string literal that follows it. Keys and values are single quoted
 * when the text contains a double quote.
 */
function parseDictionary(file) {
  const text = readFileSync(file, "utf8");
  const entries = new Map();
  const keyPattern = /^ {2}("?[A-Za-z0-9_.-]+"?|'[A-Za-z0-9_.-]+'):/gm;
  let match;

  while ((match = keyPattern.exec(text)) !== null) {
    const key = match[1].replace(/^["']|["']$/g, "");
    const after = text.slice(match.index + match[0].length);
    const value = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/s.exec(after);
    if (value) {
      entries.set(key, value[1].replace(/^["']|["']$/g, ""));
    }
  }

  return entries;
}

const locales = readdirSync(I18N_DIR)
  .filter((name) => name.endsWith(".ts") && name !== "index.ts")
  .map((name) => name.replace(/\.ts$/, ""))
  .sort();

const source = parseDictionary(join(I18N_DIR, `${SOURCE}.ts`));
const total = source.size;

if (total === 0) {
  console.error(`No keys parsed from ${SOURCE}.ts in ${I18N_DIR}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const localeArg = args.includes("--locale") ? args[args.indexOf("--locale") + 1] : undefined;
const showAll = args.includes("--all");

function report(locale) {
  const dict = parseDictionary(join(I18N_DIR, `${locale}.ts`));
  const missing = [];
  const untranslated = [];
  let translated = 0;

  for (const [key, sourceValue] of source) {
    const value = dict.get(key);
    if (value === undefined) {
      missing.push(key);
    } else if (value === sourceValue) {
      untranslated.push(key);
    } else {
      translated += 1;
    }
  }

  const pct = ((translated / total) * 100).toFixed(1);
  return { locale, translated, untranslated, missing, pct };
}

if (localeArg) {
  if (!locales.includes(localeArg)) {
    console.error(`Unknown locale "${localeArg}". Available: ${locales.join(", ")}`);
    process.exit(1);
  }

  const result = report(localeArg);
  console.log(`${localeArg}: ${result.translated}/${total} translated (${result.pct}%)`);

  if (result.missing.length > 0) {
    console.log(`\nmissing (build will fail) — ${result.missing.length}:`);
    for (const key of result.missing) console.log(`  ${key}`);
  }

  const toPrint = showAll ? [...result.untranslated] : result.untranslated;
  if (toPrint.length > 0) {
    console.log(`\nstill English — ${toPrint.length}:`);
    for (const key of toPrint) console.log(`  ${key}`);
  }

  if (result.missing.length === 0 && result.untranslated.length === 0) {
    console.log("\nfully translated");
  }
} else {
  console.log(`source: ${SOURCE} (${total} keys)\n`);
  console.log("locale    translated   coverage   missing");
  for (const locale of locales) {
    const r = report(locale);
    const label = locale.padEnd(9);
    const count = `${r.translated}/${total}`.padEnd(13);
    const pct = `${r.pct}%`.padEnd(10);
    console.log(`${label}${count}${pct}${r.missing.length}`);
  }
  console.log("\nA non-zero 'missing' column means the build fails. Run with --locale <code> for detail.");
}
