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
  { command: "status", descriptionKey: "cmd.description.status" },
  { command: "new", descriptionKey: "cmd.description.new" },
  { command: "abort", descriptionKey: "cmd.description.stop" },
  { command: "detach", descriptionKey: "cmd.description.detach" },
  { command: "sessions", descriptionKey: "cmd.description.sessions" },
  { command: "messages", descriptionKey: "cmd.description.messages" },
  { command: "settings", descriptionKey: "cmd.description.settings" },
  { command: "persona", descriptionKey: "cmd.description.persona" },
  { command: "projects", descriptionKey: "cmd.description.projects" },
  { command: "worktree", descriptionKey: "cmd.description.worktree" },
  { command: "task", descriptionKey: "cmd.description.task" },
  { command: "tasklist", descriptionKey: "cmd.description.tasklist" },
  { command: "rename", descriptionKey: "cmd.description.rename" },
  { command: "commands", descriptionKey: "cmd.description.commands" },
  { command: "skills", descriptionKey: "cmd.description.skills" },
  { command: "mcps", descriptionKey: "cmd.description.mcps" },
  { command: "opencode_start", descriptionKey: "cmd.description.opencode_start" },
  { command: "opencode_stop", descriptionKey: "cmd.description.opencode_stop" },
  { command: "open", descriptionKey: "cmd.description.open" },
  { command: "ls", descriptionKey: "cmd.description.ls" },
  { command: "help", descriptionKey: "cmd.description.help" },
];

/**
 * Commands only an admin may use.
 *
 * These are the operations that change the machine rather than the conversation: starting and
 * stopping the OpenCode server, browsing the filesystem, managing worktrees, and managing MCP
 * connections. Hiding them from the menu is presentation, so the same list is also enforced
 * in the command router below; the menu change is a courtesy that keeps the restricted menu
 * honest about what the account can do.
 */
export const ADMIN_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "opencode_start",
  "opencode_stop",
  "open",
  "ls",
  "worktree",
  "mcps",
]);

/** Whether a command is permitted for a policy. */
export function isCommandAllowedForPolicy(command: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !ADMIN_ONLY_COMMANDS.has(command);
}

export function getLocalizedBotCommands(options?: { adminOnly?: boolean }): BotCommandDefinition[] {
  const visible = options?.adminOnly
    ? COMMAND_DEFINITIONS
    : COMMAND_DEFINITIONS.filter(({ command }) => !ADMIN_ONLY_COMMANDS.has(command));
  return visible.map(({ command, descriptionKey }) => ({
    command,
    description: t(descriptionKey),
  }));
}

export const BOT_COMMANDS: BotCommandDefinition[] = getLocalizedBotCommands();

export const BUILT_IN_COMMAND_NAMES = ["start", ...COMMAND_DEFINITIONS.map(({ command }) => command)];
