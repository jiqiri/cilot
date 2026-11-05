import { Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { createMainKeyboard } from "../keyboards/main-reply-keyboard.js";
import { getStoredAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { formatVariantForButton } from "../../app/services/variant-selection-service.js";
import { clearSession } from "../../app/services/session-service.js";
import { clearProject, setCurrentProject } from "../../app/stores/settings-store.js";
import { ensurePersonalProject } from "../../app/services/project-service.js";
import { abortCurrentOperation, type AbortCommandDeps } from "./abort-command.js";
import { t } from "../../i18n/index.js";
import { detachAttachedSession } from "../../app/services/attach-service.js";
import { isAdminUser, isConfinedAdmin } from "../../app/services/access-control.js";
import {
  startLocalServerIfNeeded,
  type OpencodeStartCommandDeps,
} from "./opencode-start-command.js";

export type StartCommandDeps = AbortCommandDeps &
  Pick<AppContainer, "keyboardManager" | "pinnedMessageManager" | "resetAggregator"> &
  OpencodeStartCommandDeps;

export async function startCommand(ctx: Context, deps: StartCommandDeps): Promise<void> {
  // One command for both meanings: an admin whose server is down gets it started, everyone
  // else (and an admin whose server is up) gets the welcome/reset. The admin check lives
  // here because /start itself must stay available to every account, unlike /stop.
  if (isAdminUser(ctx.from?.id)) {
    await startLocalServerIfNeeded(ctx, deps);
  }

  if (ctx.chat) {
    if (!deps.pinnedMessageManager.isInitialized()) {
      deps.pinnedMessageManager.initialize(ctx.api, ctx.chat.id);
    }
    deps.keyboardManager.initialize(ctx.api, ctx.chat.id);
  }

  await abortCurrentOperation(ctx, deps, { notifyUser: false });
  detachAttachedSession("start_command_reset", deps);
  deps.foregroundSessionState.clearAll("start_command_reset");
  deps.assistantRunState.clearAll("start_command_reset");

  clearSession();
  clearProject();

  // An account without access to the machine's projects starts in the workspace created for
  // it, so the reset leaves the bot usable instead of asking for a project it cannot see.
  if (!isAdminUser(ctx.from?.id) || isConfinedAdmin(ctx.from?.id)) {
    const personal = await ensurePersonalProject(ctx.from?.id);
    if (personal) {
      setCurrentProject(personal);
    }
  }

  deps.keyboardManager.clearContext();
  await deps.pinnedMessageManager.clear();

  if (deps.pinnedMessageManager.getContextLimit() === 0) {
    await deps.pinnedMessageManager.refreshContextLimit();
  }

  // Get current agent, model, and context
  const currentAgent = getStoredAgent();
  const currentModel = getStoredModel();
  const variantName = formatVariantForButton(currentModel.variant || "default");
  const contextInfo =
    deps.pinnedMessageManager.getContextInfo() ??
    (deps.pinnedMessageManager.getContextLimit() > 0
      ? { tokensUsed: 0, tokensLimit: deps.pinnedMessageManager.getContextLimit() }
      : null);

  deps.keyboardManager.updateAgent(currentAgent);
  deps.keyboardManager.updateModel(currentModel);
  if (contextInfo) {
    deps.keyboardManager.updateContext(contextInfo.tokensUsed, contextInfo.tokensLimit);
  }

  const keyboard = createMainKeyboard(
    currentAgent,
    currentModel,
    contextInfo ?? undefined,
    variantName,
  );

  await ctx.reply(t("start.welcome"), { reply_markup: keyboard });
}
