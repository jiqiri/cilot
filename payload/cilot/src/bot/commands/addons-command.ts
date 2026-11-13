import type { CommandContext, Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { isAdminUser } from "../../app/services/access-control.js";
import {
  listInstalledAddons,
  versionAtLeast,
  type InstalledAddon,
} from "../../app/services/addon-manifest-service.js";
import { enabledAddonIds } from "../../app/services/addon-registry-service.js";
import { grantOf, readAddonPolicy } from "../../app/services/addon-policy-service.js";
import { defaultProfile, readProfile } from "../../app/services/addon-config-service.js";
import { getBotVersion } from "../../runtime/bot-version.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import {
  buildAddonsListKeyboard,
  buildAddonsListText,
  type AddonListItem,
} from "../menus/addon-menu.js";

export type AddonsCommandDeps = Pick<AppContainer, "interactionManager">;

/**
 * `/addons` — the list of installed add-ons.
 *
 * The command itself only builds the list. Every screen after it is rendered by the callback
 * handler, which re-checks the caller because a callback is a separate entry point.
 *
 * An admin sees every installed add-on, including a disabled one and one whose manifest is
 * broken. A standard account sees only per-user add-ons it has been granted, plus enabled
 * global ones; an add-on it cannot use is not shown at all.
 */
export async function addonsCommand(
  ctx: CommandContext<Context>,
  deps: AddonsCommandDeps,
): Promise<void> {
  try {
    const userId = ctx.from?.id;
    if (userId === undefined || userId === null) {
      await ctx.reply(t("addons.not_permitted"));
      return;
    }

    const isAdmin = isAdminUser(userId);
    const items = await buildListItems(userId, isAdmin);
    if (items.length === 0) {
      await ctx.reply(t("addons.empty"));
      return;
    }

    const message = await ctx.reply(buildAddonsListText(items, isAdmin), {
      reply_markup: buildAddonsListKeyboard(items),
    });

    deps.interactionManager.start({
      kind: "custom",
      expectedInput: "callback",
      metadata: {
        flow: "addons",
        stage: "list",
        messageId: message.message_id,
      },
    });
  } catch (error) {
    logger.error("[Addons] Could not open the add-on list:", error);
    await ctx.reply(t("addons.error.upstream", { reason: (error as Error).message ?? "unknown" }));
  }
}

/** Shared with the callback handler, which refreshes the same list after a change. */
export async function buildListItems(
  userId: number,
  isAdmin: boolean,
): Promise<AddonListItem[]> {
  const addons = await listInstalledAddons();
  const enabled = await enabledAddonIds();
  const botVersion = await getBotVersion();
  const items: AddonListItem[] = [];

  for (const addon of addons) {
    const manifest = addon.manifest;
    const supported = manifest?.minCilotVersion
      ? versionAtLeast(botVersion, manifest.minCilotVersion)
      : true;

    let grant: AddonListItem["grant"] = "off";
    if (manifest?.scope === "per-user") {
      grant = grantOf(await readAddonPolicy(addon.id), userId);
    } else {
      // A global add-on has one profile and no per-account policy. Its gate is the MCP entry
      // and the agent permission, so an enabled global add-on is shown to everyone.
      grant = enabled.has(addon.id) ? "use" : "off";
    }

    if (!isAdmin && grant !== "use") continue;
    if (!manifest && !isAdmin) continue;

    const summary = await summarize(addon, userId).catch(() => undefined);
    items.push({
      addon,
      enabled: enabled.has(addon.id) && supported,
      grant,
      summary: summary ?? manifest?.description ?? "",
    });
  }

  return items;
}

/**
 * A short, profile-derived line for the list. The description is the fallback, because a
 * profile that cannot be read is exactly what the admin needs to see and fix.
 */
async function summarize(
  addon: InstalledAddon,
  userId: number,
): Promise<string | undefined> {
  const manifest = addon.manifest;
  if (!manifest || manifest.scope !== "per-user") return undefined;
  const { profile } = await readProfile(addon, userId).catch(async () => ({
    profile: await defaultProfile(addon),
    exists: false,
  }));

  const labels = Array.isArray(profile.labels)
    ? profile.labels.filter((entry): entry is string => typeof entry === "string")
    : [];
  const folders = Array.isArray(profile.folders)
    ? profile.folders.filter((entry): entry is string => typeof entry === "string")
    : [];

  if (profile.mode === "mailbox") {
    return folders.length > 0 ? `mailbox · ${folders.join(", ")}` : "mailbox";
  }
  return labels.length > 0 ? `labels: ${labels.join(", ")}` : "labels: none";
}
