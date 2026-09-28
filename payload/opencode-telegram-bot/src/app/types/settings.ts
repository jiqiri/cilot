import type { ModelInfo } from "./model.js";
import type { ProjectInfo } from "./project.js";
import type { SessionDirectoryCacheInfo, SessionInfo } from "./session.js";
import type { ScheduledTask } from "./scheduled-task.js";

export type ResponseStreamingMode = "edit" | "draft";

export interface ScheduledTaskSessionIgnoreInfo {
  sessionId: string;
  createdAt: string;
}

/**
 * Everything that belongs to one Telegram account. Two users of the same bot get
 * separate slices, so changing agent, persona, project or toggles in one account
 * does not move them under the other one.
 */
export interface UserSettings {
  currentProject?: ProjectInfo | undefined;
  currentSession?: SessionInfo | undefined;
  currentAgent?: string | undefined;
  currentModel?: ModelInfo | undefined;
  pinnedMessageId?: number | undefined;
  ttsMode?: "off" | "all" | "auto" | undefined;
  compactOutputMode?: boolean | undefined;
  deleteCompactProgressOnFinish?: boolean | undefined;
  showThinkingContent?: boolean | undefined;
  showAssistantRunFooter?: boolean | undefined;
  pinnedDashboardEnabled?: boolean | undefined;
  responseStreamingMode?: ResponseStreamingMode | undefined;
  sendDiffFileAttachments?: boolean | undefined;
  promptQueueEnabled?: boolean | undefined;
  dismissedProjects?: string[] | undefined;
  /**
   * Sessions this account created. OpenCode has no owner field on a session, so
   * ownership is tracked here and used to filter the session list, otherwise a second
   * account could open and read the first account's conversations.
   */
  ownedSessionIds?: string[] | undefined;
  activePersonaId?: string | undefined;
  scheduledTasks?: ScheduledTask[] | undefined;
  scheduledTaskSessionIgnores?: ScheduledTaskSessionIgnoreInfo[] | undefined;
}

export type PerUserSettingKey = keyof UserSettings;

export const PER_USER_SETTING_KEYS: readonly PerUserSettingKey[] = [
  "currentProject",
  "currentSession",
  "currentAgent",
  "currentModel",
  "pinnedMessageId",
  "ttsMode",
  "compactOutputMode",
  "deleteCompactProgressOnFinish",
  "showThinkingContent",
  "showAssistantRunFooter",
  "pinnedDashboardEnabled",
  "responseStreamingMode",
  "sendDiffFileAttachments",
  "promptQueueEnabled",
  "dismissedProjects",
  "ownedSessionIds",
  "activePersonaId",
  "scheduledTasks",
  "scheduledTaskSessionIgnores",
];

/**
 * The on-disk shape. Per-user fields live under `users`, keyed by Telegram user id.
 * The flat per-user fields are still accepted on read so a settings.json written by an
 * earlier version migrates instead of being discarded; loadSettings moves them into the
 * primary user's slice and rewrites the file.
 */
export interface Settings extends Partial<UserSettings> {
  version?: number | undefined;
  users?: Record<string, UserSettings> | undefined;
  sessionDirectoryCache?: SessionDirectoryCacheInfo | undefined;
}
