import { getAgentEmoji } from "../types/agent.js";
import { DURATION_ICON, formatDuration } from "./duration-formatter.js";

interface AssistantRunFooterParams {
  agent: string;
  providerID: string;
  modelID: string;
  elapsedMs: number;
}

/**
 * Telegram has no font-size control. A quote block is the closest thing to a sub-heading:
 * clients draw it indented with a vertical bar, so the agent reads as secondary to the
 * product name without pretending to be a different type size.
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
  return `🤖 <b>Cilot</b>\n<blockquote>${details}</blockquote>`;
}
