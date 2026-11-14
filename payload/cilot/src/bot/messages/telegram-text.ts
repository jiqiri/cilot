import type { Api, RawApi } from "grammy";
import type { MessageEntity } from "grammy/types";
import { logger } from "../../utils/logger.js";
import {
  editMessageWithMarkdownFallback,
  isTelegramBadRequestError,
  sendMessageWithMarkdownFallback,
} from "./send-with-markdown-fallback.js";
import { chunkPlainText } from "../render/chunker.js";
import { TELEGRAM_TEXT_MESSAGE_LIMIT } from "../render/limits.js";
import { getTelegramRenderedPartSignature } from "../render/part-signature.js";
import type { TelegramRenderedPart } from "../render/types.js";
import { redactSecrets } from "../../app/services/secret-redaction.js";
import { redactTelegramPart } from "./redacted-part.js";

type SendMessageApi = Pick<Api<RawApi>, "sendMessage" | "sendRichMessage">;
type EditMessageApi = Pick<Api<RawApi>, "editMessageText">;
type SendDraftApi = Pick<Api<RawApi>, "sendMessageDraft" | "sendRichMessageDraft">;

type TelegramSendMessageOptions = Parameters<SendMessageApi["sendMessage"]>[2];
type TelegramEditMessageOptions = Parameters<EditMessageApi["editMessageText"]>[3];
type TelegramSendRichOptions = Parameters<SendMessageApi["sendRichMessage"]>[2];

export type TelegramTextFormat = "raw" | "markdown_v2" | "html";

interface SendBotTextParams {
  api: Pick<Api<RawApi>, "sendMessage">;
  chatId: Parameters<SendMessageApi["sendMessage"]>[0];
  text: string;
  rawFallbackText?: string | undefined;
  options?: TelegramSendMessageOptions | undefined;
  format?: TelegramTextFormat | undefined;
}

interface EditBotTextParams {
  api: EditMessageApi;
  chatId: Parameters<EditMessageApi["editMessageText"]>[0];
  messageId: Parameters<EditMessageApi["editMessageText"]>[1];
  text: string;
  rawFallbackText?: string | undefined;
  options?: TelegramEditMessageOptions | undefined;
  format?: TelegramTextFormat | undefined;
}

interface SendRenderedBotPartParams {
  api: SendMessageApi;
  chatId: Parameters<SendMessageApi["sendMessage"]>[0];
  part: TelegramRenderedPart;
  options?: TelegramSendMessageOptions;
  /** Streaming callers degrade whole payloads themselves and must opt out. */
  allowPlainFallback?: boolean;
}

interface EditRenderedBotPartParams {
  api: EditMessageApi;
  chatId: Parameters<EditMessageApi["editMessageText"]>[0];
  messageId: Parameters<EditMessageApi["editMessageText"]>[1];
  part: TelegramRenderedPart;
  options?: TelegramEditMessageOptions;
  allowPlainFallback?: boolean;
}

interface RenderedPartDeliveryResult {
  deliveredSignature: string;
  degradedToPlain?: boolean;
}

interface RenderedPartSendResult extends RenderedPartDeliveryResult {
  messageId: number;
}

export { getTelegramRenderedPartSignature };

function resolveParseMode(format: TelegramTextFormat | undefined): "MarkdownV2" | "HTML" | undefined {
  if (format === "markdown_v2") {
    return "MarkdownV2";
  }

  if (format === "html") {
    return "HTML";
  }

  return undefined;
}

/**
 * A plain retry for an HTML send. Telegram rejects the whole message when it cannot parse
 * the entities, so the fallback must not contain the tags or the user sees `<b>` literal.
 * `&amp;` is decoded last so `&amp;lt;` does not become `<`.
 */
function htmlToPlain(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripRichFormattingOptions<T extends TelegramSendMessageOptions | undefined>(
  options: T,
): T {
  if (!options) {
    return options;
  }

  const rawOptions = {
    ...options,
  } as NonNullable<T> & { parse_mode?: unknown };

  delete rawOptions.parse_mode;

  return rawOptions as T;
}

function isPlainPart(part: TelegramRenderedPart): boolean {
  return part.source === "plain" || part.blocks.length === 0;
}

function plainSignature(text: string, entities?: MessageEntity[]): string {
  return getTelegramRenderedPartSignature({
    blocks: [],
    fallbackText: text,
    source: "plain",
    entities,
  });
}

/** Plain parts may carry entities; today only reasoning does. */
function withPlainEntities<T extends { entities?: MessageEntity[] } | undefined>(
  options: T,
  part: TelegramRenderedPart,
): T {
  if (!part.entities?.length) {
    return options;
  }

  return { ...(options ?? {}), entities: part.entities } as T;
}

export async function sendBotText({
  api,
  chatId,
  text,
  rawFallbackText,
  options,
  format = "raw",
}: SendBotTextParams): Promise<void> {
  const fallbackText =
    rawFallbackText ?? (format === "html" ? htmlToPlain(text) : undefined);

  await sendMessageWithMarkdownFallback({
    api,
    chatId,
    text: redactSecrets(text),
    rawFallbackText: fallbackText === undefined ? undefined : redactSecrets(fallbackText),
    options,
    parseMode: resolveParseMode(format),
  });
}

export async function sendRenderedBotPart({
  api,
  chatId,
  part,
  options,
  allowPlainFallback = true,
}: SendRenderedBotPartParams): Promise<RenderedPartSendResult> {
  const safePart = redactTelegramPart(part);
  const rawOptions = stripRichFormattingOptions(options);

  logger.debug("[Bot] Sending rendered Telegram part", {
    source: safePart.source,
    blockCount: safePart.blocks.length,
    fallbackTextLength: safePart.fallbackText.length,
  });

  if (isPlainPart(safePart)) {
    const sentMessage = await api.sendMessage(
      chatId,
      safePart.fallbackText,
      withPlainEntities(rawOptions, safePart),
    );
    return {
      messageId: sentMessage.message_id,
      deliveredSignature: plainSignature(safePart.fallbackText, safePart.entities),
    };
  }

  try {
    const sentMessage = await api.sendRichMessage(
      chatId,
      { blocks: safePart.blocks },
      rawOptions as TelegramSendRichOptions,
    );

    return {
      messageId: sentMessage.message_id,
      deliveredSignature: getTelegramRenderedPartSignature(safePart),
    };
  } catch (error) {
    if (!allowPlainFallback || !isTelegramBadRequestError(error)) {
      throw error;
    }

    logger.warn("[Bot] Rich message send failed, retrying assistant part as plain text", error);

    const chunks = chunkPlainText(safePart.fallbackText);
    let firstMessageId: number | null = null;
    for (const chunk of chunks) {
      const sentMessage = await api.sendMessage(chatId, chunk.fallbackText, rawOptions);
      firstMessageId ??= sentMessage.message_id;
    }

    if (firstMessageId === null) {
      throw error;
    }

    logger.debug("[Bot] Assistant message part sent in plain fallback mode", {
      fallbackTextLength: safePart.fallbackText.length,
      partCount: chunks.length,
    });

    return {
      messageId: firstMessageId,
      deliveredSignature: plainSignature(safePart.fallbackText),
      degradedToPlain: true,
    };
  }
}

export async function editRenderedBotPart({
  api,
  chatId,
  messageId,
  part,
  options,
  allowPlainFallback = true,
}: EditRenderedBotPartParams): Promise<RenderedPartDeliveryResult> {
  const safePart = redactTelegramPart(part);
  const rawOptions = stripRichFormattingOptions(options);

  logger.debug("[Bot] Editing rendered Telegram part", {
    messageId,
    source: safePart.source,
    blockCount: safePart.blocks.length,
    fallbackTextLength: safePart.fallbackText.length,
  });

  if (isPlainPart(safePart)) {
    await api.editMessageText(
      chatId,
      messageId,
      safePart.fallbackText,
      withPlainEntities(rawOptions, safePart),
    );
    return {
      deliveredSignature: plainSignature(safePart.fallbackText, safePart.entities),
    };
  }

  try {
    await api.editMessageText(chatId, messageId, { blocks: safePart.blocks }, rawOptions);

    return {
      deliveredSignature: getTelegramRenderedPartSignature(safePart),
    };
  } catch (error) {
    // An edit targets exactly one message, so there is nothing to split it
    // across; a plain retry is only possible when the text fits a message.
    if (
      !allowPlainFallback ||
      !isTelegramBadRequestError(error) ||
      safePart.fallbackText.length > TELEGRAM_TEXT_MESSAGE_LIMIT
    ) {
      throw error;
    }

    logger.warn("[Bot] Rich message edit failed, retrying assistant edit as plain text", error);
    await api.editMessageText(chatId, messageId, safePart.fallbackText, rawOptions);
    logger.debug("[Bot] Assistant edit part applied in plain fallback mode", {
      messageId,
      fallbackTextLength: safePart.fallbackText.length,
    });
    return {
      deliveredSignature: plainSignature(safePart.fallbackText),
      degradedToPlain: true,
    };
  }
}

interface SendDraftBotPartParams {
  api: SendDraftApi;
  chatId: Parameters<SendDraftApi["sendMessageDraft"]>[0];
  draftId: number;
  part: TelegramRenderedPart;
}

interface CompleteDraftPartParams {
  api: SendMessageApi;
  chatId: Parameters<SendMessageApi["sendMessage"]>[0];
  part: TelegramRenderedPart;
  options?: TelegramSendMessageOptions;
}

export async function sendDraftBotPart({
  api,
  chatId,
  draftId,
  part,
}: SendDraftBotPartParams): Promise<RenderedPartDeliveryResult> {
  const safePart = redactTelegramPart(part);

  logger.debug("[Bot] Sending draft part", {
    draftId,
    source: safePart.source,
    blockCount: safePart.blocks.length,
  });

  if (isPlainPart(safePart)) {
    await api.sendMessageDraft(chatId, draftId, safePart.fallbackText);
    return {
      deliveredSignature: plainSignature(safePart.fallbackText),
    };
  }

  await api.sendRichMessageDraft(chatId, draftId, { blocks: safePart.blocks });
  return {
    deliveredSignature: getTelegramRenderedPartSignature(safePart),
  };
}

export async function completeDraftPart({
  api,
  chatId,
  part,
  options,
}: CompleteDraftPartParams): Promise<RenderedPartSendResult> {
  const safePart = redactTelegramPart(part);
  const rawOptions = stripRichFormattingOptions(options);

  logger.debug("[Bot] Completing draft with real message", {
    source: safePart.source,
    blockCount: safePart.blocks.length,
  });

  if (isPlainPart(safePart)) {
    const sentMessage = await api.sendMessage(chatId, safePart.fallbackText, rawOptions);
    return {
      messageId: sentMessage.message_id,
      deliveredSignature: plainSignature(safePart.fallbackText),
    };
  }

  const sentMessage = await api.sendRichMessage(
    chatId,
    { blocks: safePart.blocks },
    rawOptions as TelegramSendRichOptions,
  );
  return {
    messageId: sentMessage.message_id,
    deliveredSignature: getTelegramRenderedPartSignature(safePart),
  };
}

export async function editBotText({
  api,
  chatId,
  messageId,
  text,
  rawFallbackText,
  options,
  format = "raw",
}: EditBotTextParams): Promise<void> {
  await editMessageWithMarkdownFallback({
    api,
    chatId,
    messageId,
    text: redactSecrets(text),
    rawFallbackText: rawFallbackText === undefined ? undefined : redactSecrets(rawFallbackText),
    options,
    parseMode: resolveParseMode(format),
  });
}
