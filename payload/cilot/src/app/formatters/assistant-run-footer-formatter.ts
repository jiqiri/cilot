import { getAgentEmoji } from "../types/agent.js";
import { DURATION_ICON, formatDuration } from "./duration-formatter.js";

interface AssistantRunFooterParams {
  agent: string;
  providerID: string;
  modelID: string;
  elapsedMs: number;
}

/**
 * The brand and the run details share one line. Bold is the only hierarchy Telegram offers
 * without adding a line, and a quote block wrapped the long detail line on narrow screens.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The agent name without the fallback robot, because the brand line already carries it.
 * Known agents keep their icon (`📋 Plan`, `🛠️ Build`); `social-media` stays plain text.
 */
function agentLabel(agent: string): string {
  const name = agent.charAt(0).toUpperCase() + agent.slice(1);
  const emoji = getAgentEmoji(agent);
  return emoji === "🤖" ? name : `${emoji} ${name}`;
}

export function formatAssistantRunFooter({
  agent,
  providerID,
  modelID,
  elapsedMs,
}: AssistantRunFooterParams): string {
  const details = `${escapeHtml(agentLabel(agent))} · 🧠 ${escapeHtml(providerID)}/${escapeHtml(
    modelID,
  )} · ${DURATION_ICON} ${formatDuration(elapsedMs)}`;
  return `🤖 <b>Cilot</b> · ${details}`;
}
