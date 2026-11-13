/**
 * In-process per-account budget.
 *
 * One connection per call is deliberate, so the thing worth limiting is calls, not
 * connections. 30/minute is far above a scheduled task every 15 minutes and far below a
 * runaway loop, and the counter is per process, which is per workspace, which is per account.
 */
const WINDOW_MS = 60_000;
const MAX_CALLS = 30;
const calls = new Map();
export function takeBudget(account, now = Date.now()) {
    const recent = (calls.get(account) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
    if (recent.length >= MAX_CALLS) {
        calls.set(account, recent);
        return false;
    }
    recent.push(now);
    calls.set(account, recent);
    return true;
}
