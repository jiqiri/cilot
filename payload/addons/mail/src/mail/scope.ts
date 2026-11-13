import { fail } from "../shared/errors.js";
import type { Profile } from "../shared/profile.js";
import type { FolderInfo } from "./imap.js";

/**
 * What a profile may read, and how a tool argument is checked against it.
 *
 * In `labels` mode the configured set is the whole world: a label that exists on the server
 * but is not configured is refused, so an injected "search the whole mailbox" cannot widen
 * the scope. In `mailbox` mode any folder the server lists is allowed.
 */

export function configuredScope(profile: Profile): string[] {
  const labels = Array.isArray(profile.labels) ? profile.labels.filter(isName) : [];
  const folders = Array.isArray(profile.folders) ? profile.folders.filter(isName) : [];
  return [...new Set([...labels, ...folders])];
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isLabelsMode(profile: Profile): boolean {
  return profile.mode !== "mailbox";
}

export function defaultMailbox(profile: Profile): string {
  const scope = configuredScope(profile);
  return scope[0] ?? "INBOX";
}

export function labelScopeTargets(profile: Profile, label?: string, folder?: string): string[] {
  if (label && folder) {
    fail("invalid_config", "Pass either `label` or `folder`, not both.");
  }

  const scope = configuredScope(profile);
  const requested = label ?? folder;
  if (requested) {
    if (!scope.includes(requested)) {
      fail(
        "invalid_config",
        `"${requested}" is not in this profile's scope. Use mail_labels to see what is allowed.`,
      );
    }
    return [requested];
  }
  if (scope.length === 0) {
    fail(
      "not_configured",
      "This profile is in labels mode with no labels or folders configured. An admin must name what the agent may read in /addons.",
    );
  }
  return scope;
}

export function mailboxTargets(
  profile: Profile,
  listed: FolderInfo[],
  label?: string,
  folder?: string,
): string[] {
  if (label && folder) {
    fail("invalid_config", "Pass either `label` or `folder`, not both.");
  }
  const requested = label ?? folder;
  if (!requested) return [defaultMailbox(profile)];

  const exists = listed.some((entry) => entry.path === requested || entry.name === requested);
  if (!exists) {
    fail("invalid_config", `No folder or label named "${requested}" exists in this mailbox.`);
  }
  const match = listed.find((entry) => entry.path === requested || entry.name === requested);
  return [match?.path ?? requested];
}

/** Reading a message names a folder, so a folder outside the scope is authorization, not config. */
export function readTarget(
  profile: Profile,
  listed: FolderInfo[],
  label?: string,
  folder?: string,
): string {
  const requested = folder ?? label;
  if (!requested) return defaultMailbox(profile);

  if (isLabelsMode(profile)) {
    if (!configuredScope(profile).includes(requested)) {
      fail(
        "not_granted",
        `"${requested}" is outside this profile's scope. An admin can widen it in /addons.`,
      );
    }
    return requested;
  }

  return mailboxTargets(profile, listed, undefined, requested)[0] ?? requested;
}
