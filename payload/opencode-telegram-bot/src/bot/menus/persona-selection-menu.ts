import { InlineKeyboard } from "grammy";
import { t } from "../../i18n/index.js";
import type { PersonaInfo } from "../../app/services/persona-service.js";

export const PERSONA_CALLBACK_PREFIX = "persona:";
export const PERSONA_CLOSE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}close`;
export const PERSONA_NONE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}none`;
export const PERSONA_CREATE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}create`;
export const PERSONA_MANAGE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}manage`;
export const PERSONA_DELETE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}delete`;
export const PERSONA_EDIT_TEXT_CALLBACK = `${PERSONA_CALLBACK_PREFIX}edit_text`;
export const PERSONA_EDIT_NAME_CALLBACK = `${PERSONA_CALLBACK_PREFIX}edit_name`;
export const PERSONA_BACK_CALLBACK = `${PERSONA_CALLBACK_PREFIX}back`;
export const PERSONA_DELETE_CONFIRM_CALLBACK = `${PERSONA_CALLBACK_PREFIX}delete_confirm`;
export const PERSONA_DELETE_CANCEL_CALLBACK = `${PERSONA_CALLBACK_PREFIX}delete_cancel`;

export const PERSONA_ACTIVE_MARK = "✅";

export function personaSelectCallback(id: string): string {
  return `${PERSONA_CALLBACK_PREFIX}select:${id}`;
}

export function parsePersonaSelectCallback(data: string): string | null {
  const prefix = `${PERSONA_CALLBACK_PREFIX}select:`;
  if (!data.startsWith(prefix)) {
    return null;
  }
  const id = data.slice(prefix.length);
  return id.length > 0 ? id : null;
}

export function personaLabel(persona: PersonaInfo): string {
  return `${persona.isActive ? PERSONA_ACTIVE_MARK : "▫️"} ${persona.name}`;
}

export function formatPersonaListText(personas: PersonaInfo[], activeId: string | undefined): string {
  const active = personas.find((persona) => persona.id === activeId);
  const header = active
    ? t("persona.menu.text_active", { name: active.name })
    : t("persona.menu.text_inactive");

  const lines = personas.map((persona) =>
    persona.description ? `${personaLabel(persona)} — ${persona.description}` : personaLabel(persona),
  );

  return [header, "", ...lines, "", t("persona.menu.hint")].join("\n");
}

/** Close sits on the first row so it is always reachable without scrolling past the list. */
export function buildPersonaListKeyboard(personas: PersonaInfo[], activeId?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard.text(t("persona.button.close"), PERSONA_CLOSE_CALLBACK).row();

  for (const persona of personas) {
    keyboard.text(personaLabel(persona), personaSelectCallback(persona.id)).row();
  }

  if (activeId) {
    keyboard
      .text(t("persona.button.none"), PERSONA_NONE_CALLBACK)
      .text(t("persona.button.manage"), PERSONA_MANAGE_CALLBACK)
      .row();
  } else {
    keyboard.text(t("persona.button.none"), PERSONA_NONE_CALLBACK).row();
  }

  return keyboard.text(t("persona.button.create"), PERSONA_CREATE_CALLBACK);
}

export function buildPersonaManageKeyboard(persona: PersonaInfo | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (!persona) {
    return keyboard.text(t("persona.button.back"), PERSONA_BACK_CALLBACK);
  }

  keyboard.text(t("persona.button.close"), PERSONA_CLOSE_CALLBACK).row();

  return keyboard
    .text(t("persona.button.edit_text"), PERSONA_EDIT_TEXT_CALLBACK)
    .text(t("persona.button.edit_name"), PERSONA_EDIT_NAME_CALLBACK)
    .row()
    .text(t("persona.button.delete"), PERSONA_DELETE_CALLBACK)
    .row()
    .text(t("persona.button.back"), PERSONA_BACK_CALLBACK);
}

export function buildPersonaDeleteKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("persona.button.delete_confirm"), PERSONA_DELETE_CONFIRM_CALLBACK)
    .text(t("persona.button.delete_cancel"), PERSONA_DELETE_CANCEL_CALLBACK)
    .row()
    .text(t("persona.button.back"), PERSONA_BACK_CALLBACK);
}
