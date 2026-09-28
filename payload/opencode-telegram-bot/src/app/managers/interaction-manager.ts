import { getActiveSettingsUser } from "../stores/settings-store.js";
import type {
  ActiveInteraction,
  InteractionClearReason,
  InteractionPayloads,
  InteractionState,
  StartInteractionOptions,
  StatefulInteractionKind,
  TransitionInteractionOptions,
  WaitingAgentRequest,
  WaitingAgentRequestListener,
} from "../types/interaction.js";
import type { PermissionRequest } from "../types/permission.js";
import type { Question } from "../types/question.js";
import { logger } from "../../utils/logger.js";

export const DEFAULT_ALLOWED_INTERACTION_COMMANDS = [
  "/help",
  "/status",
  "/abort",
  "/detach",
  "/opencode_stop",
] as const;

function normalizeCommand(command: string): string | null {
  const trimmed = command.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutMention = withSlash.split("@")[0];
  if (!withoutMention || withoutMention.length <= 1) {
    return null;
  }

  return withoutMention;
}

function normalizeAllowedCommands(commands?: string[]): string[] {
  if (commands === undefined) {
    return [...DEFAULT_ALLOWED_INTERACTION_COMMANDS];
  }

  const normalized = new Set<string>();

  for (const command of commands) {
    const value = normalizeCommand(command);
    if (value) {
      normalized.add(value);
    }
  }

  return Array.from(normalized);
}

function toSnapshot(state: ActiveInteraction): InteractionState {
  return {
    kind: state.kind,
    expectedInput: state.expectedInput,
    allowedCommands: [...state.allowedCommands],
    metadata: { ...state.metadata },
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
  };
}

function isAgentRequestKind(kind: InteractionState["kind"]): boolean {
  return kind === "question" || kind === "permission";
}

export type InteractionErrorScope =
  | "question"
  | "permission"
  | "rename"
  | "taskCreation"
  | "interaction"
  | "none";

const SCOPE_TO_INTERACTION_KIND: Record<
  Exclude<InteractionErrorScope, "interaction" | "none">,
  StatefulInteractionKind
> = {
  question: "question",
  permission: "permission",
  rename: "rename",
  taskCreation: "task",
};

/**
 * The one open interaction slot, held separately per account.
 *
 * This held a single slot for the whole process, which is the other half of why one account
 * working stopped another from replying: a question or permission request from A left the
 * slot occupied, so B's next message was consumed as A's answer. Relaxing the busy gate on
 * its own would therefore have made it worse, turning a "please wait" into a wrong answer
 * attributed to the wrong person.
 *
 * Keyed by the active account, which the auth middleware scopes per update and the event
 * bridge scopes per session owner, so no call site has to pass an account in. The listener
 * stays process-wide: it is a dispatch hook, not per-account state.
 */
interface InteractionSlot {
  state: ActiveInteraction | null;
  waiting: WaitingAgentRequest | null;
  generation: number;
}

export class InteractionManager {
  private readonly slots = new Map<number | null, InteractionSlot>();

  private get slot(): InteractionSlot {
    const key = getActiveSettingsUser();
    let entry = this.slots.get(key);
    if (!entry) {
      entry = { state: null, waiting: null, generation: 0 };
      this.slots.set(key, entry);
    }
    return entry;
  }

  private onWaitingRequestReady: WaitingAgentRequestListener | null = null;

  /**
   * Opens the slot, replacing whatever it held. Replacing never releases the
   * waiting request: only a clear does.
   */
  start(options: StartInteractionOptions): InteractionState {
    const now = Date.now();
    let expiresAt: number | null = null;

    if (this.slot.state) {
      this.drop("state_replaced");
    }

    const { expiresInMs, ...rest } = options;
    if (typeof expiresInMs === "number") {
      expiresAt = now + expiresInMs;
    }

    const nextState: ActiveInteraction = {
      ...rest,
      allowedCommands: normalizeAllowedCommands(options.allowedCommands),
      metadata: options.metadata ? { ...options.metadata } : {},
      createdAt: now,
      expiresAt,
    };

    this.slot.state = nextState;

    logger.info(
      `[InteractionManager] Started interaction: kind=${nextState.kind}, expectedInput=${nextState.expectedInput}, allowedCommands=${nextState.allowedCommands.join(",") || "none"}`,
    );

    return toSnapshot(nextState);
  }

  get(): InteractionState | null {
    if (!this.slot.state) {
      return null;
    }

    return toSnapshot(this.slot.state);
  }

  getSnapshot(): InteractionState | null {
    return this.get();
  }

  /**
   * Live data of the given kind, or null when the slot holds another kind.
   */
  getPayload<K extends StatefulInteractionKind>(kind: K): InteractionPayloads[K] | null {
    if (!this.slot.state || this.slot.state.kind !== kind || !("payload" in this.slot.state)) {
      return null;
    }

    return this.slot.state.payload as InteractionPayloads[K];
  }

  isActive(): boolean {
    return this.slot.state !== null;
  }

  isExpired(referenceTimeMs: number = Date.now()): boolean {
    if (!this.slot.state || this.slot.state.expiresAt === null) {
      return false;
    }

    return referenceTimeMs >= this.slot.state.expiresAt;
  }

  transition(options: TransitionInteractionOptions): InteractionState | null {
    if (!this.slot.state) {
      return null;
    }

    const now = Date.now();

    this.slot.state = {
      ...this.slot.state,
      expectedInput: options.expectedInput ?? this.slot.state.expectedInput,
      allowedCommands:
        options.allowedCommands !== undefined
          ? normalizeAllowedCommands(options.allowedCommands)
          : [...this.slot.state.allowedCommands],
      metadata: options.metadata ? { ...options.metadata } : { ...this.slot.state.metadata },
      expiresAt:
        options.expiresInMs === undefined
          ? this.slot.state.expiresAt
          : options.expiresInMs === null
            ? null
            : now + options.expiresInMs,
    };

    logger.debug(
      `[InteractionManager] Transitioned interaction: kind=${this.slot.state.kind}, expectedInput=${this.slot.state.expectedInput}, allowedCommands=${this.slot.state.allowedCommands.join(",") || "none"}`,
    );

    return toSnapshot(this.slot.state);
  }

  /**
   * Empties the slot. When a question or permission ends and a request of the
   * other kind is waiting, that request is handed to the listener.
   */
  clear(reason: InteractionClearReason = "manual"): void {
    const clearedKind = this.drop(reason);
    if (!clearedKind || !isAgentRequestKind(clearedKind) || !this.slot.waiting) {
      return;
    }

    const request = this.slot.waiting;
    const generation = this.slot.generation;
    const listener = this.onWaitingRequestReady;
    this.slot.waiting = null;

    if (!listener) {
      logger.warn(
        `[InteractionManager] No listener for the waiting request, dropping it: kind=${request.kind}`,
      );
      return;
    }

    logger.info(
      `[InteractionManager] Releasing waiting request: kind=${request.kind}, after=${clearedKind}`,
    );
    setImmediate(() => listener(request, generation));
  }

  /**
   * Clears the slot only if it holds the given kind.
   */
  clearKind(kind: InteractionState["kind"], reason: InteractionClearReason): void {
    if (this.slot.state?.kind === kind) {
      this.clear(reason);
    }
  }

  /**
   * Drops the slot and the waiting request together, and marks permission
   * prompts still being sent as stale.
   */
  reset(reason: InteractionClearReason): void {
    const interactionSnapshot = this.getSnapshot();
    const waitingKind = this.getWaitingKind();

    this.slot.waiting = null;
    this.bumpGeneration();
    this.drop(reason);

    const message =
      `[InteractionCleanup] Cleared state: reason=${reason}, ` +
      `interactionKind=${interactionSnapshot?.kind || "none"}, waiting=${waitingKind || "none"}`;

    if (interactionSnapshot !== null || waitingKind !== null) {
      logger.info(message);
      return;
    }

    logger.debug(message);
  }

  /**
   * Drops only what a failed handler in the given scope may have left behind.
   */
  clearErrorScope(scope: InteractionErrorScope, reason: InteractionClearReason): void {
    if (scope === "none") {
      return;
    }

    const stateBefore = this.getSnapshot();

    if (scope === "interaction") {
      this.clear(reason);
    } else {
      if (scope === "permission") {
        // Bump first, so a poll released by this clear carries the new generation.
        this.bumpGeneration();
      }

      this.clearKind(SCOPE_TO_INTERACTION_KIND[scope], reason);
    }

    logger.debug(
      `[InteractionCleanup] Cleared scoped state: reason=${reason}, scope=${scope}, interactionKind=${stateBefore?.kind || "none"}`,
    );
  }

  getGeneration(): number {
    return this.slot.generation;
  }

  bumpGeneration(): void {
    this.slot.generation++;
  }

  waitQuestion(questions: Question[], requestID: string, sessionId: string): void {
    if (this.slot.waiting?.kind === "question") {
      logger.info(
        `[InteractionManager] Replacing waiting poll: requestID=${this.slot.waiting.requestID}`,
      );
    }

    this.slot.waiting = { kind: "question", questions, requestID, sessionId };
    logger.info(`[InteractionManager] Poll is waiting: requestID=${requestID}`);
  }

  waitPermission(request: PermissionRequest): void {
    const requests = this.slot.waiting?.kind === "permission" ? this.slot.waiting.requests : [];
    if (!requests.some((waiting) => waiting.id === request.id)) {
      requests.push(request);
    }

    this.slot.waiting = { kind: "permission", requests };
    logger.info(
      `[InteractionManager] Permission is waiting: requestID=${request.id}, waiting=${requests.length}`,
    );
  }

  dropWaitingPermission(requestID: string): void {
    if (this.slot.waiting?.kind !== "permission") {
      return;
    }

    const requests = this.slot.waiting.requests.filter((request) => request.id !== requestID);
    if (requests.length === this.slot.waiting.requests.length) {
      return;
    }

    this.slot.waiting = requests.length > 0 ? { kind: "permission", requests } : null;
    logger.info(`[InteractionManager] Dropped waiting permission: requestID=${requestID}`);
  }

  dropWaitingQuestion(): boolean {
    if (this.slot.waiting?.kind !== "question") {
      return false;
    }

    logger.info(`[InteractionManager] Dropped waiting poll: requestID=${this.slot.waiting.requestID}`);
    this.slot.waiting = null;
    return true;
  }

  getWaitingKind(): WaitingAgentRequest["kind"] | null {
    return this.slot.waiting?.kind ?? null;
  }

  setOnWaitingRequestReady(listener: WaitingAgentRequestListener | null): void {
    this.onWaitingRequestReady = listener;
  }

  private drop(reason: InteractionClearReason): InteractionState["kind"] | null {
    if (!this.slot.state) {
      return null;
    }

    const kind = this.slot.state.kind;
    logger.info(
      `[InteractionManager] Cleared interaction: reason=${reason}, kind=${kind}, expectedInput=${this.slot.state.expectedInput}`,
    );

    this.slot.state = null;
    return kind;
  }
}
