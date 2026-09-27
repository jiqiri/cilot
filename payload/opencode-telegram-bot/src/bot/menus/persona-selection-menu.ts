import { InlineKeyboard } from "grammy";
import { t } from "../../i18n/index.js";
import type { PersonaInfo } from "../../app/services/persona-service.js";

export const PERSONA_CALLBACK_PREFIX = "persona:";
export const PERSONA_CLOSE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}close`;
export const PERSONA_NONE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}none`;
export const PERSONA_CREATE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}create`;
export const PERSONA_EDIT_CALLBACK = `${PERSONA_CALLBACK_PREFIX}edit`;
export const PERSONA_DELETE_CALLBACK = `${PERSONA_CALLBACK_PREFIX}delete`;
export const PERSONA_DELETE_CONFIRM_CALLBACK = `${PERSONA_CALLBACK_PREFIX}delete_confirm`;
export const PERSONA_DELETE_CANCEL_CALLBACK = `${PERSONA_CALLBACK_PREFIX}delete_cancel`;

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

export function formatPersonaListText(
  personas: PersonaInfo[],
  activeId: string | undefined,
): string {
  const active = personas.find((persona) => persona.id === activeId);
  const header = active
    ? t("persona.menu.text_active", { name: active.name })
    : t("persona.menu.text_inactive");

  const lines = personas.map((persona) => {
    const mark = persona.isActive ? "✅" : "▫️";
    return persona.description
      ? `${mark} ${persona.name} — ${persona.description}`
      : `${mark} ${persona.name}`;
  });

  return [header, "", ...lines, "", t("persona.menu.hint")].join("\n");
}

export function buildPersonaListKeyboard(personas: PersonaInfo[], activeId?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const persona of personas) {
    const label = persona.isActive ? `✅ ${persona.name}` : persona.name;
    keyboard.text(label, personaSelectCallback(persona.id)).row();
  }

  if (activeId) {
    keyboard
      .text(t("persona.button.none"), PERSONA_NONE_CALLBACK)
      .text(t("persona.button.edit"), PERSONA_EDIT_CALLBACK)
      .row();
  } else {
    keyboard.text(t("persona.button.none"), PERSONA_NONE_CALLBACK).row();
  }

  return keyboard
    .text(t("persona.button.create"), PERSONA_CREATE_CALLBACK)
    .text(t("persona.button.delete"), PERSONA_DELETE_CALLBACK)
    .row()
    .text(t("persona.button.close"), PERSONA_CLOSE_CALLBACK);
}

export function buildPersonaDeleteKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(t("persona.button.delete_confirm"), PERSONA_DELETE_CONFIRM_CALLBACK)
    .text(t("persona.button.delete_cancel"), PERSONA_DELETE_CANCEL_CALLBACK)
    .row()
    .text(t("persona.button.close"), PERSONA_CLOSE_CALLBACK);
}
