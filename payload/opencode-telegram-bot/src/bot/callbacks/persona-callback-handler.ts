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
  readPersona,
  savePersona,
  type PersonaInfo,
} from "../../app/services/persona-service.js";
import { getActivePersonaId, setActivePersonaId } from "../../app/stores/settings-store.js";
import {
  PERSONA_BACK_CALLBACK,
  PERSONA_CALLBACK_PREFIX,
  PERSONA_CLOSE_CALLBACK,
  PERSONA_CREATE_CALLBACK,
  PERSONA_DELETE_CALLBACK,
  PERSONA_DELETE_CANCEL_CALLBACK,
  PERSONA_DELETE_CONFIRM_CALLBACK,
  PERSONA_EDIT_NAME_CALLBACK,
  PERSONA_EDIT_TEXT_CALLBACK,
  PERSONA_MANAGE_CALLBACK,
  PERSONA_NONE_CALLBACK,
  buildPersonaDeleteKeyboard,
  buildPersonaListKeyboard,
  buildPersonaManageKeyboard,
  formatPersonaListText,
  parsePersonaSelectCallback,
} from "../menus/persona-selection-menu.js";

type PersonaDeps = Pick<AppContainer, "interactionManager">;

type PersonaStage = "await_name" | "await_body" | "await_edit_name" | "await_edit_text" | "delete_confirm";

interface PersonaMetadata {
  flow: "persona";
  stage: PersonaStage;
  messageId?: number;
  targetId?: string;
  targetName?: string;
}

const VALID_STAGES: readonly PersonaStage[] = [
  "await_name",
  "await_body",
  "await_edit_name",
  "await_edit_text",
  "delete_confirm",
];

export function parsePersonaMetadata(state: unknown): PersonaMetadata | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const snapshot = state as { kind?: string; metadata?: Record<string, unknown> };
  if (snapshot.kind !== "custom" || !snapshot.metadata) {
    return null;
  }
  const metadata = snapshot.metadata;
  if (metadata.flow !== "persona" || typeof metadata.stage !== "string") {
    return null;
  }
  const stage = metadata.stage as PersonaStage;
  if (!VALID_STAGES.includes(stage)) {
    return null;
  }

  const parsed: PersonaMetadata = { flow: "persona", stage };

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
  if (parsePersonaMetadata(deps.interactionManager.getSnapshot())) {
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

async function renderManage(ctx: Context, messageId?: number): Promise<void> {
  const activeId = getActivePersonaId();
  const persona = activeId ? await readPersona(activeId) : null;
  const header = persona
    ? t("persona.manage.header", { name: persona.name })
    : t("persona.manage.header_empty");
  const keyboard = buildPersonaManageKeyboard(persona);

  if (messageId !== undefined) {
    await ctx.editMessageText(header, { reply_markup: keyboard });
    return;
  }
  await ctx.reply(header, { reply_markup: keyboard });
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

  // Any persona button aborts a pending create/edit text flow. Close in particular
  // has to work while the bot is waiting for a name or a body, so the flow is
  // dropped before dispatching and re-established only by the branch that needs it.
  const wasAwaitingText = parsePersonaMetadata(deps.interactionManager.getSnapshot()) !== null;
  clearPersonaInteraction(deps, `persona_callback:${data}`);

  const activeId = getActivePersonaId();

  try {
    if (data === PERSONA_CLOSE_CALLBACK) {
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      if (wasAwaitingText) {
        await ctx.reply(t("persona.cancelled"));
      }
      return true;
    }

    if (data === PERSONA_NONE_CALLBACK) {
      await applyActivation(null);
      await ctx.answerCallbackQuery({ text: t("persona.callback.none") });
      await renderList(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    if (data === PERSONA_BACK_CALLBACK) {
      await ctx.answerCallbackQuery();
      await renderList(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    if (data === PERSONA_CREATE_CALLBACK) {
      await ctx.answerCallbackQuery();
      const prompt = await ctx.reply(t("persona.create.ask_name"));
      deps.interactionManager.start({
        kind: "custom",
        expectedInput: "text",
        metadata: { flow: "persona", stage: "await_name", messageId: prompt.message_id },
      });
      return true;
    }

    if (data === PERSONA_MANAGE_CALLBACK) {
      await ctx.answerCallbackQuery();
      await renderManage(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    if (data === PERSONA_EDIT_TEXT_CALLBACK) {
      const persona = activeId ? await readPersona(activeId) : null;
      if (!persona) {
        await ctx.answerCallbackQuery({ text: t("persona.callback.no_active"), show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery();
      const prompt = await ctx.reply(t("persona.edit.ask_body", { name: persona.name }));
      deps.interactionManager.start({
        kind: "custom",
        expectedInput: "text",
        metadata: {
          flow: "persona",
          stage: "await_edit_text",
          targetId: persona.id,
          targetName: persona.name,
          messageId: prompt.message_id,
        },
      });
      return true;
    }

    if (data === PERSONA_EDIT_NAME_CALLBACK) {
      const persona = activeId ? await readPersona(activeId) : null;
      if (!persona) {
        await ctx.answerCallbackQuery({ text: t("persona.callback.no_active"), show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery();
      const prompt = await ctx.reply(t("persona.edit.ask_name", { name: persona.name }));
      deps.interactionManager.start({
        kind: "custom",
        expectedInput: "text",
        metadata: {
          flow: "persona",
          stage: "await_edit_name",
          targetId: persona.id,
          targetName: persona.name,
          messageId: prompt.message_id,
        },
      });
      return true;
    }

    if (data === PERSONA_DELETE_CALLBACK) {
      const persona = activeId ? await readPersona(activeId) : null;
      if (!persona) {
        await ctx.answerCallbackQuery({ text: t("persona.callback.no_active"), show_alert: true });
        return true;
      }
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(t("persona.delete.confirm", { name: persona.name }), {
        reply_markup: buildPersonaDeleteKeyboard(),
      });
      deps.interactionManager.start({
        kind: "custom",
        expectedInput: "callback",
        metadata: {
          flow: "persona",
          stage: "delete_confirm",
          targetId: persona.id,
          targetName: persona.name,
          ...(ctx.callbackQuery?.message?.message_id !== undefined
            ? { messageId: ctx.callbackQuery.message.message_id }
            : {}),
        },
      });
      return true;
    }

    if (data === PERSONA_DELETE_CONFIRM_CALLBACK) {
      if (activeId && (await personaExists(activeId))) {
        await deletePersona(activeId);
        await applyActivation(null);
      }
      clearPersonaInteraction(deps, "persona_deleted");
      await ctx.answerCallbackQuery({ text: t("persona.callback.deleted") });
      await renderList(ctx, ctx.callbackQuery?.message?.message_id);
      return true;
    }

    if (data === PERSONA_DELETE_CANCEL_CALLBACK) {
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
      await ctx.answerCallbackQuery({
        text: t("persona.callback.selected", { name: selected?.name ?? selectedId }),
      });
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
      if (await personaExists(id)) {
        await ctx.reply(t("persona.create.name_exists", { name: id }));
        return true;
      }
      const prompt = await ctx.reply(t("persona.create.ask_body", { name: id }));
      deps.interactionManager.transition({
        expectedInput: "text",
        metadata: {
          flow: "persona",
          stage: "await_body",
          targetId: id,
          targetName: id,
          messageId: prompt.message_id,
        },
      });
      return true;
    }

    if (!trimmed) {
      await ctx.reply(
        metadata.stage === "await_edit_name"
          ? t("persona.create.name_empty")
          : t("persona.create.body_empty"),
      );
      return true;
    }

    const targetId = metadata.targetId;
    if (!targetId) {
      deps.interactionManager.clear("persona_missing_target");
      await ctx.reply(t("persona.menu.error"));
      return true;
    }

    // The create stage runs before the file exists, so it must not require one.
    // Edit stages operate on an existing persona and bail out if it has vanished.
    const isCreating = metadata.stage === "await_body";
    const existing = isCreating ? null : await readPersona(targetId);
    if (!isCreating && !existing) {
      clearPersonaInteraction(deps, "persona_target_missing");
      await ctx.reply(t("persona.callback.missing"));
      return true;
    }

    if (metadata.stage === "await_edit_name" && existing) {
      const name = trimmed.slice(0, 60);
      await savePersona(targetId, { name, description: existing.description, body: existing.body });
      clearPersonaInteraction(deps, "persona_renamed");
      await ctx.reply(t("persona.renamed", { name }));
      await renderList(ctx);
      return true;
    }

    // Create derives the display name from the id the user picked; edit only
    // replaces the body and leaves the name and description alone.
    const display = existing?.name ?? displayName(targetId);
    await savePersona(targetId, {
      name: display,
      description: existing?.description,
      body: trimmed,
    });
    await applyActivation(targetId);
    clearPersonaInteraction(deps, "persona_saved");

    await ctx.reply(t("persona.saved", { name: display }));
    await ctx.reply(t("persona.restart_hint"));
    return true;
  } catch (error) {
    logger.error("[Persona] Error handling persona text input:", error);
    clearPersonaInteraction(deps, "persona_text_error");
    await ctx.reply(t("persona.menu.error"));
    return true;
  }
}
