import type { I18nKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";

/**
 * Centralized bot commands definitions
 * Used for both Telegram API setMyCommands and command handler registration
 */

export interface BotCommandDefinition {
  command: string;
  description: string;
}

interface BotCommandI18nDefinition {
  command: string;
  descriptionKey: I18nKey;
}

/**
 * List of all bot commands
 * Update this array when adding new commands
 */
const COMMAND_DEFINITIONS: BotCommandI18nDefinition[] = [
  { command: "start", descriptionKey: "cmd.description.start" },
  { command: "status", descriptionKey: "cmd.description.status" },
  { command: "new", descriptionKey: "cmd.description.new" },
  { command: "abort", descriptionKey: "cmd.description.stop" },
  { command: "detach", descriptionKey: "cmd.description.detach" },
  { command: "sessions", descriptionKey: "cmd.description.sessions" },
  { command: "messages", descriptionKey: "cmd.description.messages" },
  { command: "settings", descriptionKey: "cmd.description.settings" },
  { command: "model", descriptionKey: "cmd.description.model" },
  { command: "persona", descriptionKey: "cmd.description.persona" },
  { command: "projects", descriptionKey: "cmd.description.projects" },
  { command: "worktree", descriptionKey: "cmd.description.worktree" },
  { command: "task", descriptionKey: "cmd.description.task" },
  { command: "tasklist", descriptionKey: "cmd.description.tasklist" },
  { command: "rename", descriptionKey: "cmd.description.rename" },
  { command: "commands", descriptionKey: "cmd.description.commands" },
  { command: "skills", descriptionKey: "cmd.description.skills" },
  { command: "mcps", descriptionKey: "cmd.description.mcps" },
  { command: "vault", descriptionKey: "cmd.description.vault" },
  { command: "stop", descriptionKey: "cmd.description.server_stop" },
  { command: "open", descriptionKey: "cmd.description.open" },
  { command: "ls", descriptionKey: "cmd.description.ls" },
  { command: "help", descriptionKey: "cmd.description.help" },
];

/**
 * Commands only an admin may use.
 *
 * These are the operations that change the machine rather than the conversation: stopping
 * the OpenCode server, browsing the filesystem, managing worktrees, and managing MCP
 * connections. `/start` is deliberately not on this list: every account needs it for the
 * welcome/reset, and only the admin branch inside the handler starts the server. Hiding a
 * command from the menu is presentation, so the same list is also enforced in the command
 * router below; the menu change is a courtesy that keeps the restricted menu honest about
 * what the account can do.
 */
export const ADMIN_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "stop",
  "open",
  "ls",
  "worktree",
  "mcps",
  "vault",
]);

/**
 * Commands reserved for the first admin id.
 *
 * `/vault` holds credentials for the whole machine, so a second admin — who may start
 * servers and read the filesystem — still does not get it. Removing it from the menu is
 * presentation; `isCommandAllowedForPolicy` refuses it at dispatch.
 */
export const PRIMARY_ADMIN_ONLY_COMMANDS: ReadonlySet<string> = new Set(["vault"]);

/** Whether a command is permitted for a policy and, for the vault, a specific id. */
export function isCommandAllowedForPolicy(
  command: string,
  isAdmin: boolean,
  isPrimaryAdmin: boolean = false,
): boolean {
  if (!isAdmin) return !ADMIN_ONLY_COMMANDS.has(command);
  if (PRIMARY_ADMIN_ONLY_COMMANDS.has(command)) return isPrimaryAdmin;
  return true;
}

export function getLocalizedBotCommands(options?: {
  adminOnly?: boolean;
  primaryAdmin?: boolean;
}): BotCommandDefinition[] {
  const visible = COMMAND_DEFINITIONS.filter(({ command }) => {
    if (!options?.adminOnly && ADMIN_ONLY_COMMANDS.has(command)) {
      return false;
    }
    if (PRIMARY_ADMIN_ONLY_COMMANDS.has(command)) {
      return options?.primaryAdmin === true;
    }
    return true;
  });

  return visible.map(({ command, descriptionKey }) => ({
    command,
    description: t(descriptionKey),
  }));
}

export const BOT_COMMANDS: BotCommandDefinition[] = getLocalizedBotCommands();

export const BUILT_IN_COMMAND_NAMES = Array.from(
  new Set(["start", ...COMMAND_DEFINITIONS.map(({ command }) => command)]),
);
