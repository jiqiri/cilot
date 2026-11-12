import type { Context } from "grammy";
import { t } from "../../i18n/index.js";
import { showPersonaMenu } from "../callbacks/persona-callback-handler.js";

export async function personaCommand(ctx: Context): Promise<void> {
  await showPersonaMenu(ctx);
  if (ctx.chat) {
    return;
  }
  await ctx.reply(t("persona.menu.hint"));
}
