import path from "node:path";
import type { ModelInfo } from "../types/model.js";
import type { ProjectInfo } from "../types/project.js";
import type { SessionDirectoryCacheInfo, SessionInfo } from "../types/session.js";
import { cloneScheduledTask, type ScheduledTask } from "../types/scheduled-task.js";
import type {
  ResponseStreamingMode,
  ScheduledTaskSessionIgnoreInfo,
  Settings,
  UserSettings,
} from "../types/settings.js";
import { PER_USER_SETTING_KEYS } from "../types/settings.js";
import { config } from "../../config.js";
import { getRuntimePaths } from "../../runtime/paths.js";
import { logger } from "../../utils/logger.js";

function cloneScheduledTasks(tasks: ScheduledTask[] | undefined): ScheduledTask[] | undefined {
  return tasks?.map((task) => cloneScheduledTask(task));
}

function cloneScheduledTaskSessionIgnores(
  ignores: ScheduledTaskSessionIgnoreInfo[] | undefined,
): ScheduledTaskSessionIgnoreInfo[] | undefined {
  return ignores?.map((ignore) => ({ ...ignore }));
}

function getSettingsFilePath(): string {
  return getRuntimePaths().settingsFilePath;
}

function getSettingsBackupFilePath(): string {
  return `${getSettingsFilePath()}.bak`;
}

// Lives next to the target file so the rename never crosses a volume boundary.
function getSettingsTempFilePath(): string {
  return `${getSettingsFilePath()}.tmp`;
}

// Set when settings were recovered from the backup: the target file still holds
// the damaged content, so rotating it into the backup would destroy the only
// good copy. Cleared by the first successful write.
let skipNextBackupRotation = false;

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readSettingsFileAt(filePath: string): Promise<Settings> {
  const fs = await import("fs/promises");
  const content = await fs.readFile(filePath, "utf-8");
  return JSON.parse(content) as Settings;
}

async function readSettingsFile(): Promise<Settings> {
  const settingsFilePath = getSettingsFilePath();
  const backupFilePath = getSettingsBackupFilePath();

  try {
    return await readSettingsFileAt(settingsFilePath);
  } catch (primaryError) {
    if (!isFileNotFound(primaryError)) {
      logger.warn(
        `[SettingsManager] Cannot read settings file ${settingsFilePath}:`,
        primaryError,
      );
    }

    try {
      const backupSettings = await readSettingsFileAt(backupFilePath);
      logger.warn(`[SettingsManager] Recovered settings from backup ${backupFilePath}`);
      skipNextBackupRotation = true;
      return backupSettings;
    } catch (backupError) {
      if (isFileNotFound(primaryError) && isFileNotFound(backupError)) {
        return {};
      }

      logger.error(
        `[SettingsManager] Settings file ${settingsFilePath} and its backup ${backupFilePath} are both unusable.`,
        { primaryError, backupError },
      );
      throw new Error(
        `Cannot read settings: ${settingsFilePath} and its backup ${backupFilePath} are both unusable. ` +
          "Both files were left untouched - fix or remove them manually and start the bot again.",
      );
    }
  }
}

async function writeSettingsFileAtomically(settings: Settings): Promise<void> {
  const fs = await import("fs/promises");
  const settingsFilePath = getSettingsFilePath();
  const tempFilePath = getSettingsTempFilePath();

  await fs.mkdir(path.dirname(settingsFilePath), { recursive: true });

  try {
    await fs.writeFile(tempFilePath, JSON.stringify(settings, null, 2));

    if (!skipNextBackupRotation) {
      try {
        await fs.rename(settingsFilePath, getSettingsBackupFilePath());
      } catch (error) {
        // Nothing to back up on the very first write.
        if (!isFileNotFound(error)) {
          throw error;
        }
      }
    }

    await fs.rename(tempFilePath, settingsFilePath);
    skipNextBackupRotation = false;
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => {
      // Best-effort cleanup of the temporary file.
    });
    throw error;
  }
}

let settingsWriteQueue: Promise<void> = Promise.resolve();

function writeSettingsFile(settings: Settings): Promise<void> {
  settingsWriteQueue = settingsWriteQueue
    .catch(() => {
      // Keep write queue alive after failed writes.
    })
    .then(async () => {
      try {
        await writeSettingsFileAtomically(settings);
      } catch (err) {
        logger.error("[SettingsManager] Error writing settings file:", err);
      }
    });

  return settingsWriteQueue;
}

// Awaits the writes queued at the moment of the call; writes queued later are not
// covered. That is enough for shutdown, where everything able to write is already
// stopped. The queue never rejects - writeSettingsFile handles its own errors.
export function flushSettings(): Promise<void> {
  return settingsWriteQueue;
}

const SETTINGS_VERSION = 2;

let settingsRoot: Settings = {};

/**
 * Which Telegram account the next settings read or write applies to. Set by the auth
 * middleware on every accepted update, before any handler runs. Null only before the
 * first update arrives, when the primary account is used as a sensible default for
 * startup work such as session restore.
 */
let activeUserId: number | null = null;

export function setActiveSettingsUser(userId: number | null): void {
  activeUserId = userId;
}

export function getActiveSettingsUser(): number | null {
  return activeUserId;
}

function userKey(userId: number | null): string {
  return String(userId ?? config.telegram.allowedUserId);
}

/**
 * The mutable slice for the active account, created on first write. Every getter and
 * setter in this file goes through here, which is what isolates two users of the same
 * bot without touching any call site.
 */
function activeSlice(): UserSettings {
  const key = userKey(activeUserId);
  settingsRoot.users ??= {};
  const existing = settingsRoot.users[key];
  if (existing) {
    return existing;
  }
  const created: UserSettings = {};
  settingsRoot.users[key] = created;
  return created;
}

function persist(): Promise<void> {
  return writeSettingsFile(settingsRoot);
}

/** Every Telegram account that has a settings slice, including the primary. */
export function getKnownUserIds(): number[] {
  return Object.keys(settingsRoot.users ?? {})
    .map((key) => Number(key))
    .filter((id) => Number.isFinite(id));
}

/**
 * Runs a function against another account's slice, then restores the previous one.
 * The scheduled task runtime ticks on a timer with no incoming update, so it uses this
 * to reach each account's tasks and to write their results back to the right slice.
 */
export function withSettingsUser<T>(userId: number | null, run: () => T): T {
  const previous = activeUserId;
  activeUserId = userId;
  try {
    return run();
  } finally {
    activeUserId = previous;
  }
}

export function getCurrentProject(): ProjectInfo | undefined {
  return activeSlice().currentProject;
}

export function setCurrentProject(projectInfo: ProjectInfo): void {
  activeSlice().currentProject = projectInfo;
  void persist();
}

export function clearProject(): void {
  activeSlice().currentProject = undefined;
  void persist();
}

export function getCurrentSession(): SessionInfo | undefined {
  return activeSlice().currentSession;
}

export function setCurrentSession(sessionInfo: SessionInfo): void {
  activeSlice().currentSession = sessionInfo;
  void persist();
}

export function clearSession(): void {
  activeSlice().currentSession = undefined;
  void persist();
}

export type TtsMode = "off" | "all" | "auto";

export function getTtsMode(): TtsMode {
  return activeSlice().ttsMode ?? "off";
}

export function setTtsMode(mode: TtsMode): void {
  activeSlice().ttsMode = mode;
  void persist();
}

export function getCompactOutputMode(): boolean {
  return activeSlice().compactOutputMode ?? false;
}

export function setCompactOutputMode(enabled: boolean): void {
  activeSlice().compactOutputMode = enabled;
  void persist();
}

export function getDeleteCompactProgressOnFinish(): boolean {
  return activeSlice().deleteCompactProgressOnFinish ?? false;
}

export function setDeleteCompactProgressOnFinish(enabled: boolean): void {
  activeSlice().deleteCompactProgressOnFinish = enabled;
  void persist();
}

export function getShowThinkingContent(): boolean {
  return activeSlice().showThinkingContent ?? true;
}

export function setShowThinkingContent(enabled: boolean): void {
  activeSlice().showThinkingContent = enabled;
  void persist();
}

export function getShowAssistantRunFooter(): boolean {
  return activeSlice().showAssistantRunFooter ?? true;
}

export function setShowAssistantRunFooter(enabled: boolean): void {
  activeSlice().showAssistantRunFooter = enabled;
  void persist();
}

export function getPinnedDashboardEnabled(): boolean {
  return activeSlice().pinnedDashboardEnabled ?? true;
}

export function setPinnedDashboardEnabled(enabled: boolean): void {
  activeSlice().pinnedDashboardEnabled = enabled;
  void persist();
}

export type { ResponseStreamingMode };

export function getResponseStreamingMode(): ResponseStreamingMode {
  return activeSlice().responseStreamingMode === "draft" ? "draft" : "edit";
}

export function setResponseStreamingMode(mode: ResponseStreamingMode): void {
  activeSlice().responseStreamingMode = mode;
  void persist();
}

export function getSendDiffFileAttachments(): boolean {
  return activeSlice().sendDiffFileAttachments ?? true;
}

export function setSendDiffFileAttachments(enabled: boolean): void {
  activeSlice().sendDiffFileAttachments = enabled;
  void persist();
}

export function getPromptQueueEnabled(): boolean {
  return activeSlice().promptQueueEnabled ?? false;
}

export function setPromptQueueEnabled(enabled: boolean): void {
  activeSlice().promptQueueEnabled = enabled;
  void persist();
}

export function getOwnedSessionIds(): string[] {
  return activeSlice().ownedSessionIds ?? [];
}

export function isSessionOwned(sessionId: string): boolean {
  return getOwnedSessionIds().includes(sessionId);
}

/**
 * Claims every session the server currently reports for the active account. Used once
 * for the primary account so a settings.json that predates session ownership does not
 * appear to have lost its history.
 */
export function claimAllSessions(sessionIds: string[]): void {
  const owned = getOwnedSessionIds();
  const merged = [...owned];
  let added = 0;
  for (const id of sessionIds) {
    if (!merged.includes(id)) {
      merged.push(id);
      added += 1;
    }
  }
  if (added === 0) {
    return;
  }
  activeSlice().ownedSessionIds = merged;
  void persist();
  logger.info(`[Settings] Claimed ${added} pre-existing session(s) for user ${userKey(activeUserId)}`);
}

/** Records that the active account created a session. No-op if already claimed. */
export function claimSession(sessionId: string): void {
  const owned = getOwnedSessionIds();
  if (owned.includes(sessionId)) {
    return;
  }
  activeSlice().ownedSessionIds = [...owned, sessionId];
  void persist();
}

export function releaseSession(sessionId: string): void {
  const owned = getOwnedSessionIds();
  if (!owned.includes(sessionId)) {
    return;
  }
  activeSlice().ownedSessionIds = owned.filter((id) => id !== sessionId);
  void persist();
}

export function getDismissedProjects(): string[] {
  return activeSlice().dismissedProjects ?? [];
}

export function dismissProject(worktree: string): boolean {
  const current = getDismissedProjects();
  if (current.includes(worktree)) {
    return false;
  }
  activeSlice().dismissedProjects = [...current, worktree];
  void persist();
  return true;
}

export function undismissProject(worktree: string): boolean {
  const current = getDismissedProjects();
  if (!current.includes(worktree)) {
    return false;
  }
  activeSlice().dismissedProjects = current.filter((item) => item !== worktree);
  void persist();
  return true;
}

export function getActivePersonaId(): string | undefined {
  return activeSlice().activePersonaId;
}

export function setActivePersonaId(personaId: string | undefined): void {
  activeSlice().activePersonaId = personaId;
  void persist();
}

export function getCurrentAgent(): string | undefined {
  return activeSlice().currentAgent;
}

export function setCurrentAgent(agentName: string): void {
  activeSlice().currentAgent = agentName;
  void persist();
}

export function clearCurrentAgent(): void {
  activeSlice().currentAgent = undefined;
  void persist();
}

export function getCurrentModel(): ModelInfo | undefined {
  return activeSlice().currentModel;
}

export function setCurrentModel(modelInfo: ModelInfo): void {
  activeSlice().currentModel = modelInfo;
  void persist();
}

export function clearCurrentModel(): void {
  activeSlice().currentModel = undefined;
  void persist();
}

export function getPinnedMessageId(): number | undefined {
  return activeSlice().pinnedMessageId;
}

export function setPinnedMessageId(messageId: number): void {
  activeSlice().pinnedMessageId = messageId;
  void persist();
}

export function clearPinnedMessageId(): void {
  activeSlice().pinnedMessageId = undefined;
  void persist();
}

// The directory cache describes directories the OpenCode server has sessions for, not
// anything a specific account owns, so it is shared rather than per-user.
export function getSessionDirectoryCache(): SessionDirectoryCacheInfo | undefined {
  return settingsRoot.sessionDirectoryCache;
}

export function setSessionDirectoryCache(cache: SessionDirectoryCacheInfo): Promise<void> {
  settingsRoot.sessionDirectoryCache = cache;
  return persist();
}

export function clearSessionDirectoryCache(): void {
  settingsRoot.sessionDirectoryCache = undefined;
  void persist();
}

export function getScheduledTasks(): ScheduledTask[] {
  return cloneScheduledTasks(activeSlice().scheduledTasks) ?? [];
}

export function setScheduledTasks(tasks: ScheduledTask[]): Promise<void> {
  activeSlice().scheduledTasks = cloneScheduledTasks(tasks);
  return persist();
}

export function getScheduledTaskSessionIgnores(): ScheduledTaskSessionIgnoreInfo[] {
  return cloneScheduledTaskSessionIgnores(activeSlice().scheduledTaskSessionIgnores) ?? [];
}

export function setScheduledTaskSessionIgnores(
  ignores: ScheduledTaskSessionIgnoreInfo[],
): Promise<void> {
  activeSlice().scheduledTaskSessionIgnores = cloneScheduledTaskSessionIgnores(ignores);
  return persist();
}

export function __resetSettingsForTests(): void {
  settingsRoot = {};
  activeUserId = null;
  settingsWriteQueue = Promise.resolve();
  skipNextBackupRotation = false;
}

const VALID_TTS_MODES: readonly TtsMode[] = ["off", "all", "auto"];
const VALID_STREAMING_MODES: readonly ResponseStreamingMode[] = ["edit", "draft"];

function applyInitialSettingsPreset(preset: Record<string, unknown>): void {
  const knownKeys = new Set([
    "ttsMode",
    "compactOutputMode",
    "deleteCompactProgressOnFinish",
    "showThinkingContent",
    "showAssistantRunFooter",
    "pinnedDashboardEnabled",
    "responseStreamingMode",
    "sendDiffFileAttachments",
    "promptQueueEnabled",
  ]);

  for (const [key, value] of Object.entries(preset)) {
    if (!knownKeys.has(key)) {
      throw new Error(
        `INITIAL_SETTINGS_PRESET: unknown key "${key}". Supported keys: ${[...knownKeys].join(", ")}.`,
      );
    }
    if (key === "ttsMode") {
      if (typeof value !== "string" || !VALID_TTS_MODES.includes(value as TtsMode)) {
        throw new Error(
          `INITIAL_SETTINGS_PRESET: invalid value for "ttsMode"; expected one of ${VALID_TTS_MODES.join(", ")}.`,
        );
      }
      if (activeSlice().ttsMode === undefined) {
        activeSlice().ttsMode = value as TtsMode;
      }
    } else if (key === "responseStreamingMode") {
      if (
        typeof value !== "string" ||
        !VALID_STREAMING_MODES.includes(value as ResponseStreamingMode)
      ) {
        throw new Error(
          `INITIAL_SETTINGS_PRESET: invalid value for "responseStreamingMode"; expected one of ${VALID_STREAMING_MODES.join(", ")}.`,
        );
      }
      if (activeSlice().responseStreamingMode === undefined) {
        activeSlice().responseStreamingMode = value as ResponseStreamingMode;
      }
    } else {
      // Boolean settings: compactOutputMode, deleteCompactProgressOnFinish, showThinkingContent, showAssistantRunFooter, pinnedDashboardEnabled, sendDiffFileAttachments, promptQueueEnabled
      if (typeof value !== "boolean") {
        throw new Error(
          `INITIAL_SETTINGS_PRESET: "${key}" must be a boolean.`,
        );
      }
      switch (key) {
        case "compactOutputMode":
          if (activeSlice().compactOutputMode === undefined)
            activeSlice().compactOutputMode = value;
          break;
        case "deleteCompactProgressOnFinish":
          if (activeSlice().deleteCompactProgressOnFinish === undefined)
            activeSlice().deleteCompactProgressOnFinish = value;
          break;
        case "showThinkingContent":
          if (activeSlice().showThinkingContent === undefined)
            activeSlice().showThinkingContent = value;
          break;
        case "showAssistantRunFooter":
          if (activeSlice().showAssistantRunFooter === undefined)
            activeSlice().showAssistantRunFooter = value;
          break;
        case "pinnedDashboardEnabled":
          if (activeSlice().pinnedDashboardEnabled === undefined)
            activeSlice().pinnedDashboardEnabled = value;
          break;
        case "sendDiffFileAttachments":
          if (activeSlice().sendDiffFileAttachments === undefined)
            activeSlice().sendDiffFileAttachments = value;
          break;
        case "promptQueueEnabled":
          if (activeSlice().promptQueueEnabled === undefined)
            activeSlice().promptQueueEnabled = value;
          break;
      }
    }
  }
}

export async function loadSettings(): Promise<void> {
  const loadedSettings = (await readSettingsFile()) as Settings & {
    serverProcess?: unknown;
    toolMessagesIntervalSec?: unknown;
  };

  let requiresRewrite = false;

  if ("toolMessagesIntervalSec" in loadedSettings) {
    delete loadedSettings.toolMessagesIntervalSec;
    requiresRewrite = true;
  }

  if ("serverProcess" in loadedSettings) {
    delete loadedSettings.serverProcess;
    requiresRewrite = true;
  }

  // Migrate old ttsEnabled boolean to new ttsMode
  if ("ttsEnabled" in loadedSettings) {
    const oldEnabled = (loadedSettings as Record<string, unknown>).ttsEnabled;
    loadedSettings.ttsMode = oldEnabled === true ? "all" : "off";
    delete (loadedSettings as Record<string, unknown>).ttsEnabled;
    requiresRewrite = true;
  }

  // Before per-user storage the file was flat, with one copy of every setting at the top
  // level. Those values belong to whichever account was the only permitted one, so they
  // move into that account's slice and the flat copies are dropped.
  const flat = loadedSettings as Record<string, unknown>;
  const legacy: UserSettings = {};
  for (const key of PER_USER_SETTING_KEYS) {
    if (flat[key] !== undefined) {
      (legacy as Record<string, unknown>)[key] = flat[key];
      delete flat[key];
    }
  }

  settingsRoot = {
    version: SETTINGS_VERSION,
    users: (loadedSettings.users ?? {}) as Record<string, UserSettings>,
    sessionDirectoryCache: loadedSettings.sessionDirectoryCache,
  };
  requiresRewrite = true;

  if (Object.keys(legacy).length > 0) {
    const key = userKey(null);
    const users = settingsRoot.users ?? {};
    users[key] = { ...legacy, ...users[key] };
    settingsRoot.users = users;
    logger.info(`[Settings] Migrated flat settings into the slice for user ${key}`);
  }

  activeSlice().scheduledTasks = cloneScheduledTasks(activeSlice().scheduledTasks) ?? [];
  activeSlice().scheduledTaskSessionIgnores =
    cloneScheduledTaskSessionIgnores(activeSlice().scheduledTaskSessionIgnores) ?? [];

  applyInitialSettingsPreset(config.bot.initialSettingsPreset);

  if (requiresRewrite) {
    void persist();
  }
}
