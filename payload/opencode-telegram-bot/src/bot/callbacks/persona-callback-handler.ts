import type { Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import {
  deletePersona,
  displayName,
  listPersonas,
  materializeActivePersona,
  normalizePersonaId,
  personaExists,
  savePersona,
  type PersonaInfo,
} from "../../app/services/persona-service.js";
import { getActivePersonaId, setActivePersonaId } from "../../app/stores/settings-store.js";
import {
  PERSONA_CALLBACK_PREFIX,
  PERSONA_CLOSE_CALLBACK,
  PERSONA_CREATE_CALLBACK,
  PERSONA_DELETE_CALLBACK,
  PERSONA_DELETE_CANCEL_CALLBACK,
  PERSONA_DELETE_CONFIRM_CALLBACK,
  PERSONA_EDIT_CALLBACK,
  PERSONA_NONE_CALLBACK,
  buildPersonaDeleteKeyboard,
  buildPersonaListKeyboard,
  formatPersonaListText,
  parsePersonaSelectCallback,
} from "../menus/persona-selection-menu.js";

type PersonaDeps = Pick<AppContainer, "interactionManager">;

interface PersonaMetadata {
  flow: "persona";
  stage: "await_name" | "await_body" | "delete_confirm";
  messageId?: number;
  targetId?: string;
  targetName?: string;
  mode: "create" | "edit";
}

const RESTART_HINT = "persona.restart_hint";

export function parsePersonaMetadata(state: unknown): PersonaMetadata | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const snapshot = state as { kind?: string; metadata?: Record<string, unknown> };
  if (snapshot.kind !== "custom") {
    return null;
  }
  const metadata = snapshot.metadata;
  if (!metadata || metadata.flow !== "persona") {
    return null;
  }
  const stage = metadata.stage;
  const mode = metadata.mode;
  if (stage !== "await_name" && stage !== "await_body" && stage !== "delete_confirm") {
    return null;
  }
  if (mode !== "create" && mode !== "edit") {
    return null;
  }

  const parsed: PersonaMetadata = { flow: "persona", stage, mode };

  if (typeof metadata.messageId === "number") {
    parsed.messageId = metadata.messageId;
  }
  if (typeof metadata.targetId === "string") {
    parsed.targetId = metadata.targetId;
  }
  if (typeof metadata.targetName === "string") {
    parsed.targetName = metadata.targetName;
  }

  return parsed;
}

function clearPersonaInteraction(deps: PersonaDeps, reason: string): void {
  const metadata = parsePersonaMetadata(deps.interactionManager.getSnapshot());
  if (metadata) {
    deps.interactionManager.clear(reason as never);
  }
}

async function renderList(ctx: Context, messageId?: number): Promise<void> {
  const activeId = getActivePersonaId();
  const personas = await listPersonas(activeId);
  const text = formatPersonaListText(personas, activeId);
  const keyboard = buildPersonaListKeyboard(personas, activeId);

  if (messageId !== undefined) {
    await ctx.editMessageText(text, { reply_markup: keyboard });
    return;
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

async function applyActivation(id: string | null): Promise<void> {
  await materializeActivePersona(id);
  setActivePersonaId(id ?? undefined);
}

export async function showPersonaMenu(ctx: Context): Promise<void> {
  try {
    await renderList(ctx);
  } catch (error) {
    logger.error("[Persona] Error showing persona menu:", error);
    await ctx.reply(t("persona.menu.error"));
  }
}

export async function handlePersonaCallback(ctx: Context, deps: PersonaDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(PERSONA_CALLBACK_PREFIX)) {
    return false;
  }

  try {
    if (data === PERSONA_CLOSE_CALLBACK) {
      await ctx.answerCallbackQuery();
      clearPersonaInteraction(deps, "persona_menu_closed");
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return true;
    }

    if (data === PERSONA_NONE_CALLBACK) {
      await applyActivation(null);
      await ctx.answerCallbackQuery({ text: t("persona.callback.none") });
      await renderList(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    if (data === PERSONA_CREATE_CALLBACK) {
      await ctx.answerCallbackQuery();
      const prompt = await ctx.reply(t("persona.create.ask_name"));
      deps.interactionManager.start({
        kind: "custom",
        expectedInput: "text",
        metadata: {
          flow: "persona",
          stage: "await_name",
          mode: "create",
          messageId: prompt.message_id,
        },
      });
      return true;
    }

    if (data === PERSONA_EDIT_CALLBACK) {
      const activeId = getActivePersonaId();
      if (!activeId) {
        await ctx.answerCallbackQuery({ text: t("persona.callback.no_active"), show_alert: true });
        return true;
      }
      const personas = await listPersonas(activeId);
      const active = personas.find((persona) => persona.id === activeId);
      await ctx.answerCallbackQuery();
      const prompt = await ctx.reply(
        t("persona.edit.ask_body", { name: active?.name ?? displayName(activeId) }),
      );
      deps.interactionManager.start({
        kind: "custom",
        expectedInput: "text",
        metadata: {
          flow: "persona",
          stage: "await_body",
          mode: "edit",
          targetId: activeId,
          targetName: active?.name ?? displayName(activeId),
          messageId: prompt.message_id,
        },
      });
      return true;
    }

    if (data === PERSONA_DELETE_CALLBACK) {
      const activeId = getActivePersonaId();
      if (!activeId) {
        await ctx.answerCallbackQuery({ text: t("persona.callback.no_active"), show_alert: true });
        return true;
      }
      const personas = await listPersonas(activeId);
      const active = personas.find((persona) => persona.id === activeId);
      const name = active?.name ?? displayName(activeId);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t("persona.delete.confirm", { name }), {
        reply_markup: buildPersonaDeleteKeyboard(),
      });
      deps.interactionManager.transition({
        expectedInput: "callback",
        metadata: {
          flow: "persona",
          stage: "delete_confirm",
          mode: "edit",
          targetId: activeId,
          targetName: name,
          ...(ctx.callbackQuery?.message?.message_id !== undefined
            ? { messageId: ctx.callbackQuery.message.message_id }
            : {}),
        },
      });
      return true;
    }

    if (data === PERSONA_DELETE_CONFIRM_CALLBACK) {
      const targetId = getActivePersonaId();
      if (targetId && (await personaExists(targetId))) {
        await deletePersona(targetId);
        await applyActivation(null);
      }
      clearPersonaInteraction(deps, "persona_deleted");
      await ctx.answerCallbackQuery({ text: t("persona.callback.deleted") });
      await renderList(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    if (data === PERSONA_DELETE_CANCEL_CALLBACK) {
      clearPersonaInteraction(deps, "persona_delete_cancelled");
      await ctx.answerCallbackQuery();
      await renderList(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    const selectedId = parsePersonaSelectCallback(data);
    if (selectedId) {
      if (!(await personaExists(selectedId))) {
        await ctx.answerCallbackQuery({ text: t("persona.callback.missing"), show_alert: true });
        return true;
      }
      await applyActivation(selectedId);
      const personas: PersonaInfo[] = await listPersonas(selectedId);
      const selected = personas.find((persona) => persona.id === selectedId);
      await ctx.answerCallbackQuery({ text: t("persona.callback.selected", { name: selected?.name ?? selectedId }) });
      await renderList(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    return false;
  } catch (error) {
    logger.error("[Persona] Error handling persona callback:", error);
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") }).catch(() => {});
    return true;
  }
}

/**
 * Consumes the next plain text message as persona name or body.
 * Returns true when the message was part of a persona flow.
 */
export async function handlePersonaTextArguments(
  ctx: Context,
  deps: PersonaDeps,
): Promise<boolean> {
  const text = ctx.message?.text;
  if (text === undefined || text.startsWith("/")) {
    return false;
  }

  const metadata = parsePersonaMetadata(deps.interactionManager.getSnapshot());
  if (!metadata || metadata.stage === "delete_confirm") {
    return false;
  }

  const trimmed = text.trim();

  try {
    if (metadata.stage === "await_name") {
      if (!trimmed) {
        await ctx.reply(t("persona.create.name_empty"));
        return true;
      }
      const id = normalizePersonaId(trimmed);
      if (!id) {
        await ctx.reply(t("persona.create.name_invalid"));
        return true;
      }
      if (metadata.mode === "create" && (await personaExists(id))) {
        await ctx.reply(t("persona.create.name_exists", { name: id }));
        return true;
      }
      const prompt = await ctx.reply(t("persona.create.ask_body", { name: id }));
      deps.interactionManager.transition({
        expectedInput: "text",
        metadata: {
          flow: "persona",
          stage: "await_body",
          mode: metadata.mode,
          targetId: id,
          targetName: id,
          messageId: prompt.message_id,
        },
      });
      return true;
    }

    if (!trimmed) {
      await ctx.reply(t("persona.create.body_empty"));
      return true;
    }

    const targetId = metadata.targetId;
    if (!targetId) {
      deps.interactionManager.clear("persona_missing_target");
      await ctx.reply(t("persona.menu.error"));
      return true;
    }

    const existing = (await listPersonas(getActivePersonaId())).find(
      (persona) => persona.id === targetId,
    );
    const name = existing?.name ?? metadata.targetName ?? displayName(targetId);
    await savePersona(targetId, name, existing?.description, trimmed);
    await applyActivation(targetId);
    clearPersonaInteraction(deps, "persona_saved");

    await ctx.reply(t("persona.saved", { name }));
    await ctx.reply(t(RESTART_HINT));
    return true;
  } catch (error) {
    logger.error("[Persona] Error handling persona text input:", error);
    clearPersonaInteraction(deps, "persona_text_error");
    await ctx.reply(t("persona.menu.error"));
    return true;
  }
}
