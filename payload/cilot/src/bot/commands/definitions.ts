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
  { command: "access", descriptionKey: "cmd.description.access" },
  { command: "share", descriptionKey: "cmd.description.share" },
  { command: "user", descriptionKey: "cmd.description.user" },
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
 * `/vault` holds credentials for the whole machine, and `/access` is the switch that can
 * block every standard account, so a second admin — who may start servers and read the
 * filesystem — still does not get either. Removing them from the menu is presentation;
 * `isCommandAllowedForPolicy` refuses them at dispatch.
 */
export const PRIMARY_ADMIN_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "vault",
  "access",
  "share",
  "user",
]);

/**
 * Commands that need the bot's full reach, i.e. `/access on`.
 *
 * The bot boots confined on purpose: an admin is still allowed in, but only as an ordinary
 * account inside their own workspace. These commands stop the server, browse the filesystem,
 * read credentials or change who may use the bot, so they are exactly what should not be
 * reachable while that switch is off. `/access` is deliberately absent: it is the way back.
 */
export const ELEVATED_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  ...ADMIN_ONLY_COMMANDS,
  "vault",
  "share",
  "user",
]);

/** Whether a command is permitted for a policy and, for the vault, a specific id. */
export function isCommandAllowedForPolicy(
  command: string,
  isAdmin: boolean,
  isPrimaryAdmin: boolean = false,
  elevated: boolean = true,
): boolean {
  // The safe default applies to admins too: without `/access on`, nothing that reaches the
  // machine is dispatched. `/access` itself is not on the list, so it stays reachable.
  if (!elevated && ELEVATED_ONLY_COMMANDS.has(command)) {
    return false;
  }
  // Primary-admin commands are closed even to a non-admin: deriving the answer from
  // `ADMIN_ONLY_COMMANDS` alone would let a standard account through for any command that is
  // not also on that list.
  if (PRIMARY_ADMIN_ONLY_COMMANDS.has(command)) {
    return isAdmin && isPrimaryAdmin;
  }
  if (!isAdmin) return !ADMIN_ONLY_COMMANDS.has(command);
  return true;
}

export function getLocalizedBotCommands(options?: {
  adminOnly?: boolean;
  primaryAdmin?: boolean;
  elevated?: boolean;
}): BotCommandDefinition[] {
  const elevated = options?.elevated !== false;
  const visible = COMMAND_DEFINITIONS.filter(({ command }) => {
    if (!elevated && ELEVATED_ONLY_COMMANDS.has(command)) {
      // While the switch is off the menu shows what the account can actually run, which for
      // an admin means the ordinary commands plus `/access`.
      return false;
    }
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
