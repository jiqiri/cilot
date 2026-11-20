import type { Context } from "grammy";
import { mkdir, stat } from "node:fs/promises";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import {
  getProjectByWorktree,
  getProjects,
  isValidProjectFolderName,
  projectFolderPath,
} from "../../app/services/project-service.js";
import { dismissProject, getCurrentProject } from "../../app/stores/settings-store.js";
import {
  isForegroundBusy,
  type ForegroundBusyDeps,
} from "../../app/services/run-control-service.js";
import {
  switchToProject,
  type ProjectSwitchDeps,
} from "../../app/services/project-switch-service.js";
import { canCreateProject, userProjectsRoot } from "../../app/services/access-control.js";
import { upsertSessionDirectory } from "../../app/services/session-cache-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { InlineKeyboard } from "grammy";
import { alert, cancelPrompt, failure } from "./feedback.js";
import {
  appendInlineMenuCancelButton,
  ensureActiveInlineMenu,
  type InlineMenuDeps,
} from "../menus/inline-menu.js";
import {
  buildProjectCreateCancelKeyboard,
  buildProjectsMenuView,
  getProjectFolderName,
  parseProjectHideConfirmCallback,
  projectHideConfirmCallback,
  parseProjectPageCallback,
  PROJECT_CREATE_CALLBACK,
  PROJECT_CREATE_CANCEL_CALLBACK,
  PROJECT_HIDE_CALLBACK,
  PROJECT_HIDE_CANCEL_CALLBACK,
} from "../menus/project-selection-menu.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import {
  createProjectSwitchPresentation,
  type ProjectSwitchPresentationDeps,
} from "../services/project-switch-presentation.js";

export type ProjectSelectDeps = Pick<AppContainer, "ensureEventSubscription"> &
  ForegroundBusyDeps &
  InlineMenuDeps &
  ProjectSwitchDeps &
  ProjectSwitchPresentationDeps;

const PROJECT_CREATE_FLOW = "project_create";

interface ProjectCreateMetadata {
  flow: typeof PROJECT_CREATE_FLOW;
  messageId: number;
}

function getCreateCallbackMessageId(ctx: Context): number | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) {
    return null;
  }
  const messageId = (message as { message_id?: number }).message_id;
  return typeof messageId === "number" ? messageId : null;
}

function parseProjectCreateMetadata(state: unknown): ProjectCreateMetadata | null {
  if (!state || typeof state !== "object") return null;
  const snapshot = state as { kind?: string; metadata?: Record<string, unknown> };
  if (snapshot.kind !== "custom" || !snapshot.metadata) return null;
  if (snapshot.metadata.flow !== PROJECT_CREATE_FLOW) return null;
  if (typeof snapshot.metadata.messageId !== "number") return null;
  return { flow: PROJECT_CREATE_FLOW, messageId: snapshot.metadata.messageId };
}

function clearProjectCreateInteraction(deps: ProjectSelectDeps, reason: string): void {
  if (parseProjectCreateMetadata(deps.interactionManager.getSnapshot())) {
    deps.interactionManager.clear(reason);
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asks for a folder name and turns the reply into a project.
 *
 * Only an admin with `/access on` gets the button, matching `/open`; the folder is created
 * under the account's own workspace, which is also the boundary `canUseProjectPath` enforces,
 * so creating it cannot widen access. The name is validated before it reaches the filesystem.
 */
async function handleProjectCreate(
  ctx: Context,
  data: string,
  deps: ProjectSelectDeps,
): Promise<boolean> {
  if (data === PROJECT_CREATE_CANCEL_CALLBACK) {
    const metadata = parseProjectCreateMetadata(deps.interactionManager.getSnapshot());
    const callbackMessageId = getCreateCallbackMessageId(ctx);

    if (!metadata || callbackMessageId === null || metadata.messageId !== callbackMessageId) {
      clearProjectCreateInteraction(deps, "project_create_cancel_inactive");
      await ctx
        .answerCallbackQuery({ text: t("inline.inactive_callback"), show_alert: true })
        .catch(() => {});
      return true;
    }

    clearProjectCreateInteraction(deps, "project_create_cancelled");
    await cancelPrompt(ctx, "common.cancelled");
    return true;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "project", deps);
  if (!isActiveMenu) {
    return true;
  }

  const userId = ctx.from?.id;
  if (userId === undefined || !canCreateProject(userId)) {
    await alert(ctx, "projects.create.not_permitted");
    return true;
  }

  const messageId = getCreateCallbackMessageId(ctx);
  if (messageId === null) {
    await alert(ctx, "projects.create.error");
    return true;
  }

  try {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t("projects.create.prompt", { path: userProjectsRoot(userId) }), {
      reply_markup: buildProjectCreateCancelKeyboard(),
    });

    deps.interactionManager.start({
      kind: "custom",
      expectedInput: "mixed",
      metadata: { flow: PROJECT_CREATE_FLOW, messageId },
    });
  } catch (error) {
    logger.error("[ProjectManager] Error starting project create flow:", error);
    await ctx.answerCallbackQuery({ text: t("projects.create.error") }).catch(() => {});
  }

  return true;
}

/**
 * Consumes the folder name typed after "Create project" and creates the directory.
 *
 * Runs before the prompt handlers in the router: a text message that is really an answer to
 * this flow must never be sent to OpenCode as a prompt.
 */
export async function handleProjectCreateTextInput(
  ctx: Context,
  deps: ProjectSelectDeps,
): Promise<boolean> {
  const text = ctx.message?.text;
  if (text === undefined || text.startsWith("/")) {
    return false;
  }

  const metadata = parseProjectCreateMetadata(deps.interactionManager.getSnapshot());
  if (!metadata) {
    return false;
  }

  const userId = ctx.from?.id;
  if (userId === undefined || !canCreateProject(userId)) {
    clearProjectCreateInteraction(deps, "project_create_not_permitted");
    await ctx.reply(t("projects.create.not_permitted"));
    return true;
  }

  const name = text.trim();
  if (!isValidProjectFolderName(name)) {
    await ctx.reply(t("projects.create.invalid"));
    return true;
  }

  const target = projectFolderPath(userId, name);

  try {
    if (await pathExists(target)) {
      await ctx.reply(t("projects.create.exists", { name }));
      return true;
    }

    await mkdir(target, { recursive: true });
    await upsertSessionDirectory(target, Date.now());

    const projectInfo = await getProjectByWorktree(target);
    logger.info(`[ProjectManager] Created project folder: ${target}`);

    clearProjectCreateInteraction(deps, "project_created");

    const replyKeyboard = await switchToProject(ctx, projectInfo, "project_created", {
      ...deps,
      presentation: createProjectSwitchPresentation(deps),
    });

    await ctx.reply(t("projects.create.created", { name }), { reply_markup: replyKeyboard });

    if (ctx.chat) {
      await ctx.api.deleteMessage(ctx.chat.id, metadata.messageId).catch(() => {});
    }

    return true;
  } catch (error) {
    clearProjectCreateInteraction(deps, "project_create_error");
    logger.error("[ProjectManager] Error creating project folder:", error);
    await ctx.reply(t("projects.create.error"));
    return true;
  }
}

/**
 * Hiding is applied when the list is read rather than by deleting the session-cache
 * entry, because that cache is rebuilt from the OpenCode server on every ready refresh
 * and a deleted entry would reappear. The path goes into settings.dismissedProjects,
 * which is filtered in getProjects().
 */
async function handleProjectHide(
  ctx: Context,
  data: string,
  deps: ProjectSelectDeps,
): Promise<boolean> {
  const isActiveMenu = await ensureActiveInlineMenu(ctx, "project", deps);
  if (!isActiveMenu) {
    return true;
  }

  const canCreate = canCreateProject(ctx.from?.id);

  try {
    if (data === PROJECT_HIDE_CANCEL_CALLBACK) {
      await ctx.answerCallbackQuery();
      const projects = await getProjects();
      const { text, keyboard } = await buildProjectsMenuView(projects, 0, canCreate);
      await ctx.editMessageText(text, { reply_markup: keyboard });
      return true;
    }

    const target = parseProjectHideConfirmCallback(data);
    if (target) {
      const dismissed = dismissProject(target);
      const current = getCurrentProject();
      await ctx.answerCallbackQuery({
        text: dismissed ? t("projects.hide.hidden", { path: target }) : t("projects.hide.undone"),
      });

      // Do not leave the bot pointed at a project the user can no longer see.
      if (current?.worktree === target) {
        logger.info(`[ProjectManager] Current project was hidden: ${target}`);
      }

      const projects = await getProjects();
      if (projects.length === 0) {
        await ctx.editMessageText(t("projects.empty"), { reply_markup: { inline_keyboard: [] } }).catch(() => {});
        return true;
      }
      const { text, keyboard } = await buildProjectsMenuView(projects, 0, canCreate);
      await ctx.editMessageText(text, { reply_markup: keyboard });
      return true;
    }

    // data === PROJECT_HIDE_CALLBACK: ask which one, then confirm.
    const projects = await getProjects();
    if (projects.length === 0) {
      await alert(ctx, "projects.empty");
      return true;
    }

    const keyboard = new InlineKeyboard();
    for (const project of projects) {
      keyboard
        .text(`🗑 ${getProjectFolderName(project.worktree)}`, projectHideConfirmCallback(project.worktree))
        .row();
    }
    keyboard.text(t("projects.hide.cancel"), PROJECT_HIDE_CANCEL_CALLBACK);

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t("projects.hide.choose"), { reply_markup: keyboard });
    return true;
  } catch (error) {
    logger.error("[ProjectManager] Error hiding project:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}

export async function handleProjectSelect(ctx: Context, deps: ProjectSelectDeps): Promise<boolean> {
  const callbackQuery = ctx.callbackQuery;
  if (!callbackQuery?.data) {
    return false;
  }

  const isHideFlow =
    callbackQuery.data === PROJECT_HIDE_CALLBACK ||
    callbackQuery.data === PROJECT_HIDE_CANCEL_CALLBACK ||
    parseProjectHideConfirmCallback(callbackQuery.data) !== null;

  if (isHideFlow) {
    return handleProjectHide(ctx, callbackQuery.data, deps);
  }

  if (
    callbackQuery.data === PROJECT_CREATE_CALLBACK ||
    callbackQuery.data === PROJECT_CREATE_CANCEL_CALLBACK
  ) {
    return handleProjectCreate(ctx, callbackQuery.data, deps);
  }

  const page = parseProjectPageCallback(callbackQuery.data);
  const isProjectSelection = callbackQuery.data.startsWith("project:");

  if (page === null && !isProjectSelection) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  if (page !== null) {
    const isActiveMenu = await ensureActiveInlineMenu(ctx, "project", deps);
    if (!isActiveMenu) {
      return true;
    }

    try {
      const canCreate = canCreateProject(ctx.from?.id);
      const projects = await getProjects();
      if (projects.length === 0 && !canCreate) {
        await alert(ctx, "projects.empty");
        return true;
      }

      const { text, keyboard } = await buildProjectsMenuView(projects, page, canCreate);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        reply_markup: appendInlineMenuCancelButton(keyboard, "project"),
      });
    } catch (error) {
      logger.error("[Bot] Error switching projects page:", error);
      await ctx.answerCallbackQuery({ text: t("projects.page_load_error") });
    }

    return true;
  }

  const projectId = callbackQuery.data.replace("project:", "");

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "project", deps);
  if (!isActiveMenu) {
    return true;
  }

  try {
    const projects = await getProjects();
    const selectedProject = projects.find((p) => p.id === projectId);

    if (!selectedProject) {
      throw new Error(`Project with id ${projectId} not found`);
    }

    const projectName = selectedProject.name || selectedProject.worktree;

    logger.info(`[Bot] Project selected: ${projectName} (id: ${projectId})`);

    const keyboard = await switchToProject(ctx, selectedProject, "project_switched", {
      ...deps,
      presentation: createProjectSwitchPresentation(deps),
    });

    await ctx.answerCallbackQuery();
    await ctx.reply(t("projects.selected", { project: projectName }), {
      reply_markup: keyboard,
    });

    await ctx.deleteMessage();
  } catch (error) {
    deps.resetInteractions("project_select_error");
    logger.error("[Bot] Error selecting project:", error);
    await failure(ctx, "projects.select_error");
  }

  return true;
}
