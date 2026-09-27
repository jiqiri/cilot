import fs from "fs/promises";
import path from "path";
import { logger } from "../../utils/logger.js";

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

const STARTER_PERSONA_IDS = new Set(["professional", "sassy", "chill", "none"]);

export interface PersonaInfo {
  id: string;
  name: string;
  description?: string | undefined;
  body: string;
  isStarter: boolean;
  isDefault: boolean;
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

export function isReservedPersonaId(id: string): boolean {
  return STARTER_PERSONA_IDS.has(id);
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
  data: Record<string, string | boolean>;
  body: string;
}

function parseFrontmatter(source: string): Frontmatter {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    return { data: {}, body: normalized.trim() };
  }

  const [, rawFrontmatter = "", rawBody = ""] = match;
  const data: Record<string, string | boolean> = {};
  for (const line of rawFrontmatter.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (!key) {
      continue;
    }
    data[key] = raw === "true" ? true : raw === "false" ? false : raw;
  }

  return { data, body: rawBody.trim() };
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function renderPersonaFile(persona: {
  name: string;
  description?: string | undefined;
  isDefault: boolean;
  body: string;
}): string {
  const header = ["---", `name: ${persona.name}`];
  if (persona.description) {
    header.push(`description: ${persona.description}`);
  }
  if (persona.isDefault) {
    header.push("default: true");
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
      name: asString(data.name) ?? displayName(id),
      description: asString(data.description),
      body,
      isStarter: isReservedPersonaId(id),
      isDefault: data.default === true,
      isActive: id === activeId,
    });
  }

  return personas;
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
  update: { name: string; description?: string | undefined; isDefault: boolean; body: string },
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
      name: asString(data.name) ?? displayName(id),
      description: asString(data.description),
      body,
      isStarter: isReservedPersonaId(id),
      isDefault: data.default === true,
      isActive: false,
    };
  } catch {
    return null;
  }
}

/** Exactly one persona may carry `default: true`; this clears it on all others. */
export async function clearDefaultFlag(exceptId: string | null): Promise<void> {
  const personas = await listPersonas();

  for (const persona of personas) {
    if (!persona.isDefault || persona.id === exceptId) {
      continue;
    }
    await savePersona(persona.id, {
      name: persona.name,
      description: persona.description,
      isDefault: false,
      body: persona.body,
    });
  }
}

export async function setDefaultPersona(id: string): Promise<void> {
  const persona = await readPersona(id);
  if (!persona) {
    throw new Error(`Unknown persona: ${id}`);
  }
  await clearDefaultFlag(id);
  await savePersona(id, {
    name: persona.name,
    description: persona.description,
    isDefault: true,
    body: persona.body,
  });
}

export async function deletePersona(id: string): Promise<void> {
  const persona = await readPersona(id);
  if (persona?.isDefault) {
    throw new Error("The default persona cannot be deleted.");
  }
  await fs.unlink(path.join(getPersonaDir(), `${id}.md`));
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

  const { body } = parseFrontmatter(await fs.readFile(path.join(getPersonaDir(), `${id}.md`), "utf8"));
  await fs.writeFile(target, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
}
