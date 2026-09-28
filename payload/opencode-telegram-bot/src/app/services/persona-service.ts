import fs from "fs/promises";
import path from "path";
import { logger } from "../../utils/logger.js";
import { getActivePersonaId, setActivePersonaId } from "../stores/settings-store.js";

/**
 * Persona library.
 *
 * Personas live as individual markdown files under `<OPENCODE_CONFIG_DIR>/personas`.
 * The active one is materialised into `<OPENCODE_CONFIG_DIR>/PERSONA.md`, which is
 * referenced from `config.instructions` in opencode.jsonc:
 *
 *   { "instructions": ["PERSONA.md"] }
 *
 * `config.instructions` is additive, so PERSONA.md is injected on top of AGENTS.md
 * rather than replacing it. Only the active persona is materialised, so switching
 * personas never puts the other personas into the context window.
 */

/**
 * Ensures the PERSONA.md overlay matches the stored active persona.
 *
 * The overlay is derived state: the bot only rewrites it when someone switches
 * persona, so it can drift from settings.json. That drift is silent and bad, the
 * settings panel shows a persona as active while the model is not using it.
 * Rebuilding it at startup makes the two agree.
 */
export async function reconcileActivePersona(): Promise<void> {
  const activeId = getActivePersonaId();

  if (!activeId) {
    // No persona selected: make sure a leftover overlay cannot leak in.
    const existing = await fs.readFile(getActivePersonaFile(), "utf8").catch(() => "");
    if (existing.trim().length > 0) {
      logger.info("[Persona] No active persona stored, clearing a stale overlay");
      await materializeActivePersona(null);
    }
    return;
  }

  if (!(await personaExists(activeId))) {
    logger.warn(`[Persona] Stored active persona "${activeId}" no longer exists, clearing it`);
    setActivePersonaId(undefined);
    await materializeActivePersona(null);
    return;
  }

  const { body } = parseFrontmatter(
    await fs.readFile(path.join(getPersonaDir(), `${activeId}.md`), "utf8"),
  );
  const target = getActivePersonaFile();
  const current = await fs.readFile(target, "utf8").catch(() => "");

  // Compared against the rendered overlay, not the raw persona body. Comparing against the
  // body would never match, because the overlay also carries the shared output guide, so
  // every startup would rewrite the file and log a restore that was not needed.
  if (current.trim() !== renderPersonaOverlay(body).trim()) {
    logger.info(`[Persona] Restoring overlay for active persona "${activeId}"`);
    await materializeActivePersona(activeId);
  }
}

/**
 * Personas shipped with the installer. This is not the "default persona" marker
 * that was removed earlier: nothing is locked, nothing is flagged in a file, and
 * every one of these can be edited, renamed or deleted like any other. The list
 * only controls where a persona appears in the menu.
 *
 * Keep it in step with payload/personas in the installer repository.
 */
export const STARTER_PERSONA_IDS: readonly string[] = [
  "chill",
  "friendly",
  "no-bs",
  "professional",
  "sarcastic",
  "witty",
];

export interface PersonaInfo {
  id: string;
  name: string;
  description?: string | undefined;
  body: string;
  isStarter: boolean;
  isActive: boolean;
}

function configDir(): string {
  const configured = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (configured) {
    return configured;
  }
  const home = process.env.HOME?.trim();
  if (!home) {
    throw new Error("HOME is not set, cannot resolve the OpenCode config directory for personas.");
  }
  return path.join(process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "opencode");
}

export function getPersonaDir(): string {
  return path.join(configDir(), "personas");
}

export function getActivePersonaFile(): string {
  return path.join(configDir(), "PERSONA.md");
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function normalizePersonaId(raw: string): string | null {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  if (!id) {
    return null;
  }

  return ID_PATTERN.test(id) ? id : null;
}

interface Frontmatter {
  data: Record<string, string>;
  body: string;
}

function parseFrontmatter(source: string): Frontmatter {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return { data: {}, body: normalized.trim() };
  }

  const [, rawFrontmatter = "", rawBody = ""] = match;
  const data: Record<string, string> = {};
  for (const line of rawFrontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key) {
      data[key] = value;
    }
  }

  return { data, body: rawBody.trim() };
}

function renderPersonaFile(persona: { name: string; description?: string | undefined; body: string }): string {
  const header = ["---", `name: ${persona.name}`];
  if (persona.description) {
    header.push(`description: ${persona.description}`);
  }
  header.push("---", "");

  return `${header.join("\n")}${persona.body}\n`;
}

export function displayName(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function listPersonas(activeId?: string | undefined): Promise<PersonaInfo[]> {
  const dir = getPersonaDir();

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    logger.debug(`[Persona] Persona directory unreadable: ${String(error)}`);
    return [];
  }

  const personas: PersonaInfo[] = [];

  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const id = entry.slice(0, -3);
    const { data, body } = parseFrontmatter(await fs.readFile(path.join(dir, entry), "utf8"));
    personas.push({
      id,
      name: data.name || displayName(id),
      description: data.description,
      body,
      isStarter: STARTER_PERSONA_IDS.includes(id),
      isActive: id === activeId,
    });
  }

  // Starters first, then anything the user created, alphabetical inside each group.
  return personas.sort((left, right) => {
    if (left.isStarter !== right.isStarter) {
      return left.isStarter ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  });
}

export async function personaExists(id: string): Promise<boolean> {
  try {
    await fs.access(path.join(getPersonaDir(), `${id}.md`));
    return true;
  } catch {
    return false;
  }
}

export async function savePersona(
  id: string,
  update: { name: string; description?: string | undefined; body: string },
): Promise<void> {
  const dir = getPersonaDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.md`), renderPersonaFile(update), {
    encoding: "utf8",
    mode: 0o600,
  });
}

/** Reads a persona without going through listPersonas. */
export async function readPersona(id: string): Promise<PersonaInfo | null> {
  try {
    const { data, body } = parseFrontmatter(
      await fs.readFile(path.join(getPersonaDir(), `${id}.md`), "utf8"),
    );
    return {
      id,
      name: data.name || displayName(id),
      description: data.description,
      body,
      isStarter: STARTER_PERSONA_IDS.includes(id),
      isActive: false,
    };
  } catch {
    return null;
  }
}

export async function deletePersona(id: string): Promise<void> {
  await fs.unlink(path.join(getPersonaDir(), `${id}.md`));
}

/**
 * Appended to every persona when it is materialised, including personas the user wrote
 * themselves.
 *
 * A persona file only says how to sound. On its own that leaves the model's default
 * framing in charge, which is a terminal tool narrating what it is about to run: "I'll use
 * the bash tool", a play-by-play of commands, a restatement of the question, a closing menu
 * of next steps. None of that belongs in a chat message. Putting the guidance here rather
 * than in each persona means a persona the user creates later cannot forget it, and
 * switching personas cannot drop it.
 */
const PERSONA_OUTPUT_GUIDE = `## How to talk

You are talking to a person in a chat app. You are not a terminal, a CLI, or a tool, and
you should not describe yourself as one.

- Do not narrate your tools. No "I'll use the bash tool", no listing the commands you
  ran, no step-by-step play-by-play of the work. Report the result, not the machinery.
- Do not open with "Great question", "I can help with that", or a restatement of what was
  asked. Just answer.
- Do not close by offering a menu of next steps unless something is genuinely pending. If
  the job is done, say it is done.
- Keep it short. If a message needs scrolling, it is the wrong length.
- Use plain paragraphs and short lists. No markdown tables, no horizontal rules, no
  headings deeper than level 3, and no code fences unless the code is the answer.
- If a step failed, name the step and what you did instead, in a sentence or two. Do not
  paste a stack trace unless asked.
- Reply in the language the user writes in, and stay consistent within one reply.
- Your persona sets your voice. It never changes facts: when you are unsure, say so
  instead of sounding confident.
`;

/**
 * The persona body as it appears in PERSONA.md: the persona's own text followed by the
 * shared output guide, which every persona gets so a persona written later cannot omit it.
 */
function renderPersonaOverlay(body: string): string {
  return `${body.trimEnd()}\n\n${PERSONA_OUTPUT_GUIDE}`;
}

/**
 * Write the active persona body into PERSONA.md. Passing null clears it, which
 * removes the persona overlay and leaves the model on its default voice.
 */
export async function materializeActivePersona(id: string | null): Promise<void> {
  const target = getActivePersonaFile();

  if (id === null) {
    await fs.writeFile(target, "", { encoding: "utf8", mode: 0o600 });
    return;
  }

  let source: string;
  try {
    source = await fs.readFile(path.join(getPersonaDir(), `${id}.md`), "utf8");
  } catch {
    // The file disappeared since it was selected. Fall back to no persona rather
    // than leaving a stale persona in the system prompt.
    await fs.writeFile(target, "", { encoding: "utf8", mode: 0o600 });
    return;
  }

  const { body } = parseFrontmatter(source);
  if (!body) {
    await fs.writeFile(target, "", { encoding: "utf8", mode: 0o600 });
    return;
  }

  await fs.writeFile(target, renderPersonaOverlay(body), { encoding: "utf8", mode: 0o600 });
}
