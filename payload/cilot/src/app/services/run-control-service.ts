import { getCurrentSession } from "../stores/settings-store.js";
import type { AppContainer } from "../bootstrap/app-container.js";
import { logger } from "../../utils/logger.js";
import {
  reconcileBusyStateNow,
  type BusyReconciliationDeps,
} from "./busy-reconciliation-service.js";

export type ForegroundBusyDeps = Pick<AppContainer, "attachManager" | "foregroundSessionState">;

export type RunControlDeps = ForegroundBusyDeps & BusyReconciliationDeps;

/**
 * Whether the *active account* may not start another run right now.
 *
 * Scoped to that account's own session. The previous form asked whether any session in the
 * process was busy, which made the whole bot single-tenant: while one account's agent worked,
 * every other account was treated as busy, so its message was rejected or queued instead of
 * run. `isBusy()` is still the right question for whole-process decisions such as shutdown.
 */
export function isForegroundBusy(deps: ForegroundBusyDeps): boolean {
  return (
    deps.foregroundSessionState.isSessionBusy(getCurrentSession()?.id) || deps.attachManager.isBusy()
  );
}

function getBusyDirectories(deps: ForegroundBusyDeps): string[] {
  const directories = new Set<string>();

  for (const session of deps.foregroundSessionState.getBusySessions()) {
    directories.add(session.directory);
  }

  const attached = deps.attachManager.getSnapshot();
  if (attached?.busy) {
    directories.add(attached.directory);
  }

  return [...directories];
}

export async function reconcileForegroundBusyState(deps: RunControlDeps): Promise<void> {
  if (!isForegroundBusy(deps)) {
    return;
  }

  for (const directory of getBusyDirectories(deps)) {
    try {
      await reconcileBusyStateNow(directory, deps);
    } catch (error) {
      logger.warn("[BusyGuard] Failed to reconcile foreground busy state", error);
    }
  }
}
