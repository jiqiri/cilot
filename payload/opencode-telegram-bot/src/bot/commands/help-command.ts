import { Context } from "grammy";
import { t } from "../../i18n/index.js";
import { isAdminUser, isPrimaryAdmin } from "../../app/services/access-control.js";
import { getLocalizedBotCommands } from "./definitions.js";

function formatHelpText(admin: boolean, primaryAdmin: boolean): string {
  const commands = getLocalizedBotCommands({ adminOnly: admin, primaryAdmin });
  const lines = commands.map((item) => `/${item.command} - ${item.description}`);

  return `📖 ${t("cmd.description.help")}\n\n${lines.join("\n")}\n\n${t("help.keyboard_hint")}`;
}

export async function helpCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  // Same per-policy filter as the Telegram command menu, so /help cannot be the one place
  // that shows an account a command the router would refuse.
  await ctx.reply(formatHelpText(isAdminUser(userId), isPrimaryAdmin(userId)));
}
