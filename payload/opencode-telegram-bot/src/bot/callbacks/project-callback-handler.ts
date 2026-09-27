import type { Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { getProjects } from "../../app/services/project-service.js";
import { dismissProject, getCurrentProject } from "../../app/stores/settings-store.js";
import {
  isForegroundBusy,
  type ForegroundBusyDeps,
} from "../../app/services/run-control-service.js";
import {
  switchToProject,
  type ProjectSwitchDeps,
} from "../../app/services/project-switch-service.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { InlineKeyboard } from "grammy";
import { alert, failure } from "./feedback.js";
import {
  appendInlineMenuCancelButton,
  ensureActiveInlineMenu,
  type InlineMenuDeps,
} from "../menus/inline-menu.js";
import {
  buildProjectsMenuView,
  getProjectFolderName,
  parseProjectHideConfirmCallback,
  projectHideConfirmCallback,
  parseProjectPageCallback,
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

  try {
    if (data === PROJECT_HIDE_CANCEL_CALLBACK) {
      await ctx.answerCallbackQuery();
      const projects = await getProjects();
      const { text, keyboard } = await buildProjectsMenuView(projects, 0);
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
      const { text, keyboard } = await buildProjectsMenuView(projects, 0);
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
      const projects = await getProjects();
      if (projects.length === 0) {
        await alert(ctx, "projects.empty");
        return true;
      }

      const { text, keyboard } = await buildProjectsMenuView(projects, page);
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
