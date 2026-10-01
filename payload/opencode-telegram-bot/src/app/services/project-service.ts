import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { opencodeClient } from "../../opencode/client.js";
import { config } from "../../config.js";
import { getCachedSessionProjects } from "./session-cache-service.js";
import { getDismissedProjects } from "../stores/settings-store.js";
import { canUseProjectPath, isAdminUser } from "./access-control.js";
import { getActiveSettingsUser } from "../stores/settings-store.js";
import { logger } from "../../utils/logger.js";
import type { ProjectInfo } from "../types/project.js";

interface InternalProject extends ProjectInfo {
  lastUpdated: number;
}

async function getResolvedProjects(options?: {
  includeLinkedWorktrees?: boolean;
}): Promise<InternalProject[]> {
  const includeLinkedWorktrees = options?.includeLinkedWorktrees === true;
  const { data: projects, error } = await opencodeClient.project.list();

  if (error || !projects) {
    throw error || new Error("No data received from server");
  }

  const apiProjects: InternalProject[] = projects.map((project) => ({
    id: project.id,
    worktree: project.worktree,
    name: project.name || project.worktree,
    lastUpdated: project.time?.updated ?? 0,
  }));

  const cachedProjects = await getCachedSessionProjects();
  const mergedByWorktree = new Map<string, InternalProject>();

  for (const apiProject of apiProjects) {
    mergedByWorktree.set(worktreeKey(apiProject.worktree), apiProject);
  }

  for (const cachedProject of cachedProjects) {
    const key = worktreeKey(cachedProject.worktree);
    const existing = mergedByWorktree.get(key);

    if (existing) {
      if ((cachedProject.lastUpdated ?? 0) > existing.lastUpdated) {
        existing.lastUpdated = cachedProject.lastUpdated;
      }
      continue;
    }

    mergedByWorktree.set(key, {
      id: cachedProject.id,
      worktree: cachedProject.worktree,
      name: cachedProject.name,
      lastUpdated: cachedProject.lastUpdated ?? 0,
    });
  }

  const projectList = Array.from(mergedByWorktree.values()).sort(
    (left, right) => right.lastUpdated - left.lastUpdated,
  );

  if (includeLinkedWorktrees) {
    return projectList;
  }

  const linkedWorktreeFlags = await Promise.all(
    projectList.map((project) => isLinkedGitWorktree(project.worktree)),
  );

  const visibleProjects = projectList.filter((_, index) => !linkedWorktreeFlags[index]);
  const hiddenLinkedWorktrees = projectList.length - visibleProjects.length;

  // Two independent ways for a project to disappear from /projects: PROJECTS_EXCLUDED_PATHS
  // in the env, and paths the user dismissed from the menu. Both are applied at read time
  // rather than by deleting the underlying entry, because the session cache is repopulated
  // from the server on every OpenCode-ready refresh and would just bring them back.
  const excludedPaths = [...config.bot.excludedProjectPaths, ...getDismissedProjects()];
  const excludedKeys = new Set(excludedPaths.map((excluded) => worktreeKey(excluded)));
  const filteredProjects = excludedKeys.size > 0
    ? visibleProjects.filter((p) => !excludedKeys.has(worktreeKey(p.worktree)))
    : visibleProjects;
  const hiddenExcluded = visibleProjects.length - filteredProjects.length;
  const dismissedCount = getDismissedProjects().length;

  logger.debug(
    `[ProjectManager] Projects resolved: api=${projects.length}, cached=${cachedProjects.length}, hiddenLinkedWorktrees=${hiddenLinkedWorktrees}, hiddenExcluded=${hiddenExcluded}, dismissed=${dismissedCount}, total=${filteredProjects.length}`,
  );

  return filteredProjects;
}

async function isLinkedGitWorktree(worktree: string): Promise<boolean> {
  if (worktree === "/") {
    return false;
  }

  const gitPath = path.join(worktree, ".git");

  try {
    const gitStat = await stat(gitPath);

    if (!gitStat.isFile()) {
      return false;
    }

    const gitPointer = (await readFile(gitPath, "utf-8")).trim();
    const match = gitPointer.match(/^gitdir:\s*(.+)$/i);
    if (!match) {
      return false;
    }

    const gitDirPointer = match[1];
    if (!gitDirPointer) {
      return false;
    }
    const gitDir = path.resolve(worktree, gitDirPointer.trim()).replace(/\\/g, "/").toLowerCase();
    return gitDir.includes("/.git/worktrees/");
  } catch {
    return false;
  }
}

function worktreeKey(worktree: string): string {
  const pathModule = isWindowsWorktreePath(worktree) ? path.win32 : path.posix;
  const normalizedWorktree = pathModule.normalize(worktree);
  const root = pathModule.parse(normalizedWorktree).root;
  const trimmedWorktree =
    normalizedWorktree === root ? normalizedWorktree : normalizedWorktree.replace(/[\\/]+$/, "");

  if (pathModule === path.win32) {
    return trimmedWorktree.toLowerCase();
  }

  return trimmedWorktree;
}

function isWindowsWorktreePath(worktree: string): boolean {
  return process.platform === "win32" || /^[a-zA-Z]:[\\/]/.test(worktree) || /^\\\\/.test(worktree);
}

export function getHiddenProjectWorktrees(): string[] {
  return [...config.bot.excludedProjectPaths, ...getDismissedProjects()];
}

/**
 * Projects this account may switch to.
 *
 * The authorization runs here rather than being left to the server, because OpenCode's
 * `/project` endpoint ignores its `directory` argument and answers for the entire server: I
 * verified it returning unrelated worktrees for a scoped request. There is therefore no
 * scoped query to delegate to, and filtering a global list in the menu would still leak the
 * other accounts' projects through the result count and the page count. So the list is
 * narrowed before it is returned, and the same predicate guards the id and worktree lookups
 * below, which is what closes the indirect `/worktree` and `/open` routes.
 */
export async function getProjects(): Promise<ProjectInfo[]> {
  const userId = getActiveSettingsUser();
  const projects = await getResolvedProjects();
  const visible: ProjectInfo[] = [];
  for (const { id, worktree, name } of projects) {
    if (await isProjectVisibleToUser(userId, worktree)) {
      visible.push({ id, worktree, name });
    }
  }
  return visible;
}

/**
 * One rule for listing and for selection, so a path hidden from the menu cannot be reached
 * by asking for it directly. Admins bypass, which is a deliberate grant.
 */
export async function isProjectVisibleToUser(
  userId: number | null | undefined,
  worktree: string,
): Promise<boolean> {
  // The operator's own exclusions and this account's dismissals are a separate question
  // from authorization, and they apply to admins too: "/" is excluded precisely so the
  // agent does not run at the filesystem root, and that is true whoever is asking.
  if (isExcludedOrDismissed(worktree)) {
    return false;
  }
  if (isAdminUser(userId)) return true;
  return canUseProjectPath(userId, worktree);
}

/** True when the path is hidden by configuration or dismissed by this account. */
function isExcludedOrDismissed(worktree: string): boolean {
  const key = worktreeKey(worktree);
  const excluded = [
    ...(config.bot.excludedProjectPaths ?? []),
    ...getDismissedProjects(),
  ];
  return excluded.some((entry) => worktreeKey(entry) === key);
}

export async function getProjectById(id: string): Promise<ProjectInfo> {
  // Resolved against the full set, then authorized, because a restricted user must not be
  // able to tell "does not exist" apart from "exists but is not yours" by the error alone.
  const projects = await getResolvedProjects();
  const project = projects.find((p) => p.id === id);
  if (!project) {
    throw new Error(`Project with id ${id} not found`);
  }
  if (!(await isProjectVisibleToUser(getActiveSettingsUser(), project.worktree))) {
    logger.warn(`[Authz] Refused project id=${id} for userId=${getActiveSettingsUser()}`);
    throw new Error(`Project with id ${id} not found`);
  }
  return { id: project.id, worktree: project.worktree, name: project.name };
}

export async function getProjectByWorktree(worktree: string): Promise<ProjectInfo> {
  const projects = await getResolvedProjects({ includeLinkedWorktrees: true });
  const key = worktreeKey(worktree);
  const project = projects.find((p) => worktreeKey(p.worktree) === key);
  if (!project) {
    throw new Error(`Project with worktree ${worktree} not found`);
  }
  // The same check the list applies. Previously this lookup returned before the exclusion
  // filter and skipped the dismissal check entirely, so a project hidden from /projects was
  // still reachable by asking for its worktree.
  if (!(await isProjectVisibleToUser(getActiveSettingsUser(), project.worktree))) {
    logger.warn(
      `[Authz] Refused project worktree=${worktree} for userId=${getActiveSettingsUser()}`,
    );
    throw new Error(`Project with worktree ${worktree} not found`);
  }
  return { id: project.id, worktree: project.worktree, name: project.name };
}
