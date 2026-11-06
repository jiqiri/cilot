/**
 * Which accounts already had their Telegram command menu published.
 *
 * The menu is per chat and is published once per process, because `setMyCommands` on every
 * update would be a needless API call. The `/access` switch changes what the admin may run,
 * so it has to invalidate the entry: otherwise the menu would keep showing `/vault` and
 * `/ls` after the switch was turned off, or hide them after it was turned on, until the bot
 * restarted.
 */
const initializedFor = new Set<number>();

export function hasCommandMenu(userId: number): boolean {
  return initializedFor.has(userId);
}

export function markCommandMenuPublished(userId: number): void {
  initializedFor.add(userId);
}

export function invalidateCommandMenu(userId: number | undefined): void {
  if (userId === undefined) return;
  initializedFor.delete(userId);
}
