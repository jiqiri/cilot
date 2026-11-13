import { ImapFlow } from "imapflow";
import type { FetchMessageObject, ListResponse, MessageStructureObject, SearchObject } from "imapflow";
import { AddonError, fail } from "../shared/errors.js";
import { requireSecret, type Secrets } from "../shared/secrets.js";
import type { Profile } from "../shared/profile.js";

/**
 * One connection per call, closed in `finally`.
 *
 * A pooled connection would be faster and would also outlive a revoked grant, holding a
 * credential for an account that no longer has access. The mailbox itself is opened
 * read-only, and no mutating command appears in this file: there is no `STORE`, `COPY`,
 * `MOVE`, `APPEND`, `EXPUNGE` or `SEND` anywhere, so "read-only" is a property of the code
 * rather than a promise in a document.
 */

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  messages?: number;
  unseen?: number;
}

export interface MessageSummary {
  uid: number;
  messageId: string;
  folder: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  unread: boolean;
  size: number;
}

export interface AttachmentInfo {
  part: string;
  filename: string;
  mime: string;
  size: number;
  inline: boolean;
}

export interface MessageDetail extends MessageSummary {
  cc: string;
  text: string;
  bodyTruncated: boolean;
  attachments: AttachmentInfo[];
}

function addressList(
  addresses: ReadonlyArray<{ name?: string; address?: string }> | undefined,
): string {
  if (!addresses || addresses.length === 0) return "";
  return addresses
    .map((entry) => {
      const address = entry.address ?? "";
      return entry.name ? `${entry.name} <${address}>` : address;
    })
    .filter(Boolean)
    .join(", ");
}

function messageIdOf(message: FetchMessageObject, fallback: string): string {
  const raw = message.envelope?.messageId ?? "";
  const trimmed = raw.replace(/^<|>$/g, "").trim();
  return trimmed || fallback;
}

function dateOf(message: FetchMessageObject): string {
  const value = message.envelope?.date ?? message.internalDate;
  if (value instanceof Date) return value.toISOString();
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date(0).toISOString();
}

function connect(secrets: Secrets): ImapFlow {
  const host = requireSecret(secrets, "MAIL_IMAP_HOST");
  const user = requireSecret(secrets, "MAIL_IMAP_USER");
  const pass = requireSecret(secrets, "MAIL_IMAP_PASSWORD");
  const port = Number(secrets.MAIL_IMAP_PORT || 993);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("invalid_config", "MAIL_IMAP_PORT is not a valid port.");
  }
  const secure = port !== 143;

  return new ImapFlow({
    host,
    port,
    secure,
    // Port 143 without TLS must upgrade or refuse: credentials never cross a cleartext socket.
    doSTARTTLS: !secure,
    auth: { user, pass },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 45_000,
    tls: { minVersion: "TLSv1.2" },
  });
}

export async function withMailbox<T>(
  secrets: Secrets,
  folder: string,
  run: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = connect(secrets);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: 20_000 });
    try {
      return await run(client);
    } finally {
      lock.release();
    }
  } catch (error) {
    if (error instanceof AddonError) throw error;
    throw new AddonError("upstream_error", imapFailure(error));
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

/** A short cause with no credential and no stack trace. */
function imapFailure(error: unknown): string {
  const candidate = error as {
    authenticationFailed?: boolean;
    responseText?: string;
    serverResponseCode?: string;
    code?: string;
    message?: string;
  };
  if (candidate.authenticationFailed) {
    return "IMAP login was rejected. Check the mailbox login and app password.";
  }
  if (candidate.serverResponseCode) {
    return `IMAP server refused the request (${candidate.serverResponseCode}).`;
  }
  return `IMAP request failed${candidate.code ? ` (${candidate.code})` : ""}.`;
}

export async function listFolders(secrets: Secrets): Promise<FolderInfo[]> {
  const client = connect(secrets);
  try {
    await client.connect();
    const listed: ListResponse[] = await client.list({
      statusQuery: { messages: true, unseen: true },
    });
    return listed.map((entry) => ({
      path: entry.path,
      name: entry.name,
      delimiter: entry.delimiter,
      ...(entry.specialUse ? { specialUse: entry.specialUse } : {}),
      ...(entry.status?.messages !== undefined ? { messages: entry.status.messages } : {}),
      ...(entry.status?.unseen !== undefined ? { unseen: entry.status.unseen } : {}),
    }));
  } catch (error) {
    if (error instanceof AddonError) throw error;
    throw new AddonError("upstream_error", imapFailure(error));
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        // Already closed.
      }
    }
  }
}

export function textPartOf(node: MessageStructureObject | undefined): string | null {
  if (!node) return null;
  if (node.type === "text/plain" && node.part) return node.part;
  for (const child of node.childNodes ?? []) {
    const found = textPartOf(child);
    if (found) return found;
  }
  if (node.type === "text/html" && node.part) return node.part;
  for (const child of node.childNodes ?? []) {
    const found = textPartOf(child);
    if (found) return found;
  }
  return null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function snippetOf(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 239)}…` : collapsed;
}

async function snippetFor(
  client: ImapFlow,
  message: FetchMessageObject,
  isHtml: boolean,
): Promise<string> {
  const part = textPartOf(message.bodyStructure);
  if (!part) return "";
  try {
    const download = await client.download(message.uid, part, {
      uid: true,
      maxBytes: 4096,
      decodeText: true,
    });
    if (!download.content) return "";
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of download.content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.length;
      if (total > 4096) {
        chunks.push(buffer.subarray(0, buffer.length - (total - 4096)));
        break;
      }
      chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return snippetOf(isHtml ? stripHtml(text) : text);
  } catch {
    return "";
  }
}

/** Newest first, capped. The caller has already validated the folder. */
export async function searchMessages(
  secrets: Secrets,
  folder: string,
  query: string | undefined,
  since: Date,
  limit: number,
): Promise<MessageSummary[]> {
  return withMailbox(secrets, folder, async (client) => {
    const criteria: SearchObject = { since };
    if (query) criteria.text = query;

    const found = await client.search(criteria, { uid: true });
    const uids = Array.isArray(found) ? found : [];
    if (uids.length === 0) return [];

    // Envelope fetching is cheap, body snippets are not. Look at a generous window of the
    // newest matches, sort by date, then fetch snippets only for the page being returned.
    const window = uids.slice(-Math.max(limit * 4, limit));
    const messages: FetchMessageObject[] = [];
    for await (const message of client.fetch(
      window.join(","),
      {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        labels: true,
        bodyStructure: true,
        size: true,
      },
      { uid: true },
    )) {
      messages.push(message);
    }

    messages.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    const page = messages.slice(0, limit);
    const summaries: MessageSummary[] = [];

    for (const message of page) {
      const firstText = textPartOf(message.bodyStructure);
      const html = firstText
        ? Boolean(findNode(message.bodyStructure, (node) => node.part === firstText && node.type === "text/html"))
        : false;
      summaries.push({
        uid: message.uid,
        messageId: messageIdOf(message, `uid:${folder}:${message.uid}`),
        folder,
        from: addressList(message.envelope?.from),
        to: addressList(message.envelope?.to),
        subject: message.envelope?.subject ?? "",
        date: dateOf(message),
        snippet: await snippetFor(client, message, html),
        labels: message.labels ? [...message.labels] : [],
        unread: message.flags ? !message.flags.has("\\Seen") : false,
        size: message.size ?? 0,
      });
    }

    return summaries;
  });
}

function findNode(
  node: MessageStructureObject | undefined,
  predicate: (node: MessageStructureObject) => boolean,
): MessageStructureObject | null {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

export function collectAttachments(node: MessageStructureObject | undefined): AttachmentInfo[] {
  const parts: AttachmentInfo[] = [];
  const walk = (candidate: MessageStructureObject | undefined): void => {
    if (!candidate) return;
    for (const child of candidate.childNodes ?? []) walk(child);
    if (candidate.childNodes && candidate.childNodes.length > 0) return;
    const filename =
      candidate.dispositionParameters?.filename ?? candidate.parameters?.name ?? "";
    const isAttachment = candidate.disposition === "attachment" || Boolean(filename);
    if (!isAttachment || !candidate.part) return;
    parts.push({
      part: candidate.part,
      filename: filename || `attachment-${candidate.part}`,
      mime: candidate.type || "application/octet-stream",
      size: candidate.size ?? 0,
      inline: candidate.disposition === "inline",
    });
  };
  walk(node);
  return parts;
}

export async function readMessage(
  secrets: Secrets,
  folder: string,
  uid: number,
  profile: Profile,
): Promise<MessageDetail> {
  return withMailbox(secrets, folder, async (client) => {
    const message = await client.fetchOne(
      String(uid),
      {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
        labels: true,
        bodyStructure: true,
        size: true,
        // Headers plus the beginning of the body. A partial source still parses; a 25 MB
        // attachment is listed from the structure and downloaded only when asked.
        source: { maxLength: 2_000_000 },
      },
      { uid: true },
    );
    if (!message) {
      fail("upstream_error", `No message with uid ${uid} in "${folder}".`);
    }

    const firstText = textPartOf(message.bodyStructure);
    const html = firstText
      ? Boolean(findNode(message.bodyStructure, (node) => node.part === firstText && node.type === "text/html"))
      : false;

    let text = "";
    let bodyTruncated = false;
    if (profile.body !== "none" && message.source) {
      try {
        const { simpleParser } = await import("mailparser");
        const parsed = await simpleParser(message.source);
        const raw = parsed.text ?? (parsed.html ? stripHtml(String(parsed.html)) : "");
        if (raw.length > 20_000) {
          text = raw.slice(0, 20_000);
          bodyTruncated = true;
        } else {
          text = raw;
        }
      } catch {
        bodyTruncated = true;
        text = "";
      }
    }

    return {
      uid: message.uid,
      messageId: messageIdOf(message, `uid:${folder}:${message.uid}`),
      folder,
      from: addressList(message.envelope?.from),
      to: addressList(message.envelope?.to),
      cc: addressList(message.envelope?.cc),
      subject: message.envelope?.subject ?? "",
      date: dateOf(message),
      snippet: snippetOf(html ? stripHtml(text) : text),
      labels: message.labels ? [...message.labels] : [],
      unread: message.flags ? !message.flags.has("\\Seen") : false,
      size: message.size ?? 0,
      text,
      bodyTruncated,
      attachments: collectAttachments(message.bodyStructure),
    };
  });
}

export interface DownloadedPart {
  info: AttachmentInfo;
  buffer: Buffer;
  /** True when the server had more bytes than the limit allowed. */
  truncated: boolean;
}

export async function downloadParts(
  secrets: Secrets,
  folder: string,
  uid: number,
  parts: AttachmentInfo[],
  maxBytesPerPart: number,
): Promise<DownloadedPart[]> {
  return withMailbox(secrets, folder, async (client) => {
    const results: DownloadedPart[] = [];
    for (const part of parts) {
      const download = await client.download(uid, part.part, {
        uid: true,
        maxBytes: maxBytesPerPart + 1,
        // Attachments are bytes, not text: no charset conversion, no flowed unwrapping.
        decodeText: false,
      });
      if (!download.content) continue;

      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      for await (const chunk of download.content) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += buffer.length;
        if (total > maxBytesPerPart) {
          truncated = true;
          const keep = buffer.length - (total - maxBytesPerPart);
          if (keep > 0) chunks.push(buffer.subarray(0, keep));
          break;
        }
        chunks.push(buffer);
      }
      results.push({ info: part, buffer: Buffer.concat(chunks), truncated });
    }
    return results;
  });
}
