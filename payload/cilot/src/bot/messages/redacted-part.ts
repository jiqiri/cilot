import type { TelegramRenderedPart, TelegramRichBlock } from "../render/types.js";
import { redactSecrets } from "../../app/services/secret-redaction.js";

/**
 * Applies the credential redactor to a rendered Telegram part.
 *
 * Redacting only `fallbackText` would leave the rich representation intact, and the rich
 * path is the one the bot usually takes: a key printed inside a code block reaches the user
 * as a code block. The walk is structural rather than a list of known fields because the
 * rich-block schema is large and gains members over time; a new text-bearing field is
 * covered without a matching change here.
 *
 * `type` is the one key left alone: it is a discriminant ("paragraph", "bold", "code"), not
 * user content, and rewriting it would produce an unsendable block.
 */
export function redactTelegramPart(part: TelegramRenderedPart): TelegramRenderedPart {
  return {
    ...part,
    fallbackText: redactSecrets(part.fallbackText),
    blocks: part.blocks.map((block) => redactDeep(block)) as TelegramRichBlock[],
  };
}

function redactDeep<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, seen)) as T;
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);

    const copy: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      copy[key] = key === "type" ? child : redactDeep(child, seen);
    }
    return copy as T;
  }

  return value;
}
