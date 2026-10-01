import type { Bot, Context, NextFunction } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { isAllowedUser } from "../middleware/auth.js";
import { settingsCommand } from "../commands/settings-command.js";
import { personaCommand } from "../commands/persona-command.js";
import { opencodeStartCommand } from "../commands/opencode-start-command.js";
import { opencodeStopCommand } from "../commands/opencode-stop-command.js";
import { projectsCommand } from "../commands/projects-command.js";
import { worktreeCommand } from "../commands/worktree-command.js";
import { openCommand } from "../commands/open-command.js";
import { lsCommand } from "../commands/ls-command.js";
import { sessionsCommand } from "../commands/sessions-command.js";
import { messagesCommand } from "../commands/messages-command.js";
import { newCommand } from "../commands/new-command.js";
import { abortCommand } from "../commands/abort-command.js";
import { detachCommand } from "../commands/detach-command.js";
import { taskCommand } from "../commands/task-command.js";
import { taskListCommand } from "../commands/tasklist-command.js";
import { renameCommand } from "../commands/rename-command.js";
import { commandsCommand } from "../commands/command-catalog-command.js";
import { skillsCommand } from "../commands/skills-catalog-command.js";
import { mcpsCommand } from "../commands/mcp-catalog-command.js";
import { startCommand } from "../commands/start-command.js";
import { helpCommand } from "../commands/help-command.js";
import { statusCommand } from "../commands/status-command.js";
import { getLocalizedBotCommands, isCommandAllowedForPolicy } from "../commands/definitions.js";
import { isAdminUser } from "../../app/services/access-control.js";
import { logger } from "../../utils/logger.js";
import { flushPendingPrompt } from "../handlers/message-merger.js";
import {
  LocalCommandRegistry,
  type LocalCommandResult,
} from "../../app/services/local-command-registry.js";
import { sendMessageWithMarkdownFallback } from "../messages/send-with-markdown-fallback.js";
import { t } from "../../i18n/index.js";

interface CommandRouterDeps {
  container: AppContainer;
  localCommandRegistry?: LocalCommandRegistry;
}

// Tracked per user id: each permitted account needs its own chat-scoped command list
// published once, and a second account must not be skipped because the first was set up.
const commandsInitializedFor = new Set<number>();
/**
 * Central gate for admin-only commands.
 *
 * Hiding a command from the menu is presentation, so the refusal has to live where the
 * command is dispatched. A restricted account typing `/ls` directly is refused here rather
 * than reaching a handler that assumes the menu already filtered it.
 */
/**
 * Normalise "/ls@botname args" to "ls". Written without indexed access so it satisfies the
 * project's unchecked-index setting rather than asserting the element exists.
 */
function parseCommandName(text: string): string {
  const firstToken = text.split(/\s+/).at(0) ?? "";
  const withoutSlash = firstToken.startsWith("/") ? firstToken.slice(1) : firstToken;
  const atIndex = withoutSlash.indexOf("@");
  const name = atIndex >= 0 ? withoutSlash.slice(0, atIndex) : withoutSlash;
  return name.toLowerCase();
}

export async function enforceCommandPolicy(ctx: Context, next: NextFunction): Promise<void> {
  const message = ctx.msg;
  const text = message && "text" in message ? message.text ?? undefined : undefined;
  if (text && text.startsWith("/")) {
    const name = parseCommandName(text);
    const userId = ctx.from?.id;
    if (name && !isCommandAllowedForPolicy(name, isAdminUser(userId))) {
      logger.warn(`[Authz] Refused command /${name} for userId=${userId}: admin only`);
      await ctx.reply(t("command.admin_only"));
      return;
    }
  }
  await next();
}

export async function ensureCommandsInitialized(
  ctx: Context,
  next: NextFunction,
  localCommandRegistry = LocalCommandRegistry.empty(),
): Promise<void> {
  if (!ctx.from || !isAllowedUser(ctx.from.id) || commandsInitializedFor.has(ctx.from.id)) {
    await next();
    return;
  }

  if (!ctx.chat) {
    logger.warn("[Bot] Cannot initialize commands: chat context is missing");
    await next();
    return;
  }

  try {
    // Per policy, not per "is allowed": an admin-only account would otherwise be shown the
    // filesystem and MCP commands it cannot use.
    const admin = isAdminUser(ctx.from.id);
    await ctx.api.setMyCommands(
      [...getLocalizedBotCommands({ adminOnly: admin }), ...localCommandRegistry.definitions()],
      {
        scope: {
          type: "chat",
          chat_id: ctx.chat.id,
        },
      },
    );

    commandsInitializedFor.add(ctx.from.id);
    logger.debug(`[Bot] Commands initialized for authorized user (chat_id=${ctx.chat.id})`);
  } catch (err) {
    logger.error("[Bot] Failed to set commands:", err);
  }

  await next();
}

export function registerCommandRouter(bot: Bot<Context>, deps: CommandRouterDeps): void {
  const registry = deps.localCommandRegistry ?? LocalCommandRegistry.empty();
  const { container } = deps;
  const botDeps = { ...container, bot };
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.message?.text?.startsWith("/")) {
      flushPendingPrompt(ctx.chat.id);
    }
    await next();
  });

  bot.command("start", (ctx) => startCommand(ctx, container));
  bot.command("help", helpCommand);
  bot.command("status", (ctx) => statusCommand(ctx, container));
  bot.command("settings", (ctx) => settingsCommand(ctx, container));
  bot.command("persona", (ctx) => personaCommand(ctx));
  bot.command("opencode_start", (ctx) => opencodeStartCommand(ctx, container));
  bot.command("opencode_stop", (ctx) => opencodeStopCommand(ctx, container));
  bot.command("projects", (ctx) => projectsCommand(ctx, container));
  bot.command("worktree", (ctx) => worktreeCommand(ctx, container));
  bot.command("open", (ctx) => openCommand(ctx, container));
  bot.command("ls", (ctx) => lsCommand(ctx, container));
  bot.command("sessions", (ctx) => sessionsCommand(ctx, container));
  bot.command("messages", (ctx) => messagesCommand(ctx, container));
  bot.command("new", (ctx) => newCommand(ctx, botDeps));
  bot.command("abort", (ctx) => abortCommand(ctx, container));
  bot.command("detach", (ctx) => detachCommand(ctx, container));
  bot.command("task", (ctx) => taskCommand(ctx, container));
  bot.command("tasklist", (ctx) => taskListCommand(ctx, container));
  bot.command("rename", (ctx) => renameCommand(ctx, container));
  bot.command("commands", (ctx) => commandsCommand(ctx, container));
  bot.command("skills", (ctx) => skillsCommand(ctx, container));
  bot.command("mcps", (ctx) => mcpsCommand(ctx, container));
  for (const definition of registry.definitions()) {
    bot.command(definition.command, async (ctx) => {
      const result = await registry.execute(definition.command);
      if (!ctx.chat) return;
      await sendMessageWithMarkdownFallback({
        api: ctx.api,
        chatId: ctx.chat.id,
        text: localCommandReply(result),
      });
    });
  }
}

function localCommandReply(result: LocalCommandResult): string {
  switch (result.kind) {
    case "success": return result.text;
    case "empty": return t("local_command.empty_output");
    case "timeout": return t("local_command.timeout");
    case "failed": return t("local_command.failed", { exitCode: result.exitCode ?? "unknown", stderr: result.stderr });
  }
}
