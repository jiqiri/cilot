import type { Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { showModelSelectionMenu } from "../menus/model-selection-menu.js";

/**
 * Open the model picker.
 *
 * The picker existed only behind the reply-keyboard button, so the only way in was to
 * notice that the current model name is itself a button. That is invisible in a client
 * that has collapsed the keyboard, and it is not something a new account can discover.
 * A command gives the same menu an entry point that works from any client.
 */
export async function modelCommand(ctx: Context, container: AppContainer): Promise<void> {
  await showModelSelectionMenu(ctx, container);
}
