import { config } from "../../config.js";
import { opencodeFlavor } from "../../opencode/flavor.js";
import { OpencodeV2Http } from "../../opencode/v2/http.js";
import { logger } from "../../utils/logger.js";

/**
 * Provider credentials through the OpenCode V2 integration API.
 *
 * The server already owns a credential store, validates nothing less than the provider
 * itself, and applies a new key to the next request, so the bot has no reason to keep a
 * second copy or to write environment files for model providers. That is why this module
 * only forwards: it never reads a stored value back, because `GET /api/credential` returns
 * plaintext and there is no feature that needs it.
 *
 * Everything here is V2-only. On the V1 adapter the endpoints do not exist, and the menu
 * reports that rather than pretending the key was saved.
 */

export interface ProviderMethod {
  type: string;
  id?: string;
  label?: string;
  names?: string[];
}

export interface ProviderConnection {
  type: "credential" | "env";
  id?: string;
  label?: string;
  name?: string;
  method?: string;
}

export interface ProviderIntegration {
  id: string;
  name: string;
  methods: ProviderMethod[];
  connections: ProviderConnection[];
}

export class ProviderCredentialError extends Error {
  constructor(
    message: string,
    readonly reason: "unsupported_flavor" | "api_error" | "no_key_method" = "api_error",
  ) {
    super(message);
    this.name = "ProviderCredentialError";
  }
}

/** Providers that cover most accounts. The rest are reachable through search. */
export const PROVIDER_SHORTLIST: readonly string[] = [
  "openrouter",
  "opencode",
  "openai",
  "anthropic",
  "google",
  "google-vertex",
  "xai",
  "deepseek",
  "groq",
  "mistral",
  "cerebras",
  "nvidia",
];

let cachedClient: OpencodeV2Http | null = null;

function client(): OpencodeV2Http {
  if (opencodeFlavor !== "v2") {
    throw new ProviderCredentialError(
      "Provider keys require the OpenCode V2 API",
      "unsupported_flavor",
    );
  }

  cachedClient ??= new OpencodeV2Http({
    baseUrl: config.opencode.apiUrl,
    username: config.opencode.username,
    password: config.opencode.password,
  });

  return cachedClient;
}

/** Reset for tests; the client is stateless apart from the connection pool. */
export function resetProviderIntegrationClientForTests(): void {
  cachedClient = null;
}

/**
 * Strip a submitted key out of a provider's error text.
 *
 * Providers commonly echo the offending credential ("Incorrect API key provided: sk-…").
 * That message reaches a chat and a log line, so the one value the vault must not spread is
 * replaced before either happens.
 */
function redactSecret(message: string, secret: string): string {
  if (!secret) {
    return message;
  }
  return message.split(secret).join("***");
}

function apiError(operation: string, message: string): ProviderCredentialError {
  const trimmed = message.trim().slice(0, 200);
  logger.warn(`[Vault] Provider integration call failed: op=${operation}, error=${trimmed}`);
  return new ProviderCredentialError(trimmed || `${operation} failed`, "api_error");
}

interface IntegrationEnvelope {
  data?: ProviderIntegration[];
}

interface SingleIntegrationEnvelope {
  data?: ProviderIntegration;
}

export async function listIntegrations(): Promise<ProviderIntegration[]> {
  const result = await client().request<IntegrationEnvelope>("GET", "/api/integration");
  if (result.error) {
    throw apiError("list", result.error.data.message);
  }

  const payload = result.data;
  if (Array.isArray(payload)) {
    return payload;
  }
  return payload?.data ?? [];
}

export async function getIntegration(id: string): Promise<ProviderIntegration | null> {
  const result = await client().request<SingleIntegrationEnvelope>(
    "GET",
    `/api/integration/${encodeURIComponent(id)}`,
  );
  if (result.error) {
    throw apiError("get", result.error.data.message);
  }

  return result.data?.data ?? null;
}

export function supportsKeyMethod(integration: ProviderIntegration): boolean {
  return integration.methods.some((method) => method.type === "key");
}

/**
 * Store an API key. Resolves to the refreshed integration so the menu can show the new
 * connection without a second round trip in the caller.
 */
export async function connectProviderKey(
  id: string,
  key: string,
  label: string,
): Promise<ProviderIntegration | null> {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new ProviderCredentialError("Provider key is empty", "api_error");
  }

  const result = await client().request("POST", `/api/integration/${encodeURIComponent(id)}/connect/key`, {
    body: { key: trimmed, label },
  });
  if (result.error) {
    throw apiError("connect", redactSecret(result.error.data.message, trimmed));
  }

  return getIntegration(id);
}

/**
 * Remove a stored credential.
 *
 * Only credential connections can be deleted: an `env` connection comes from the server's
 * own environment, and removing it here would mean editing a unit file, which is not what
 * this button promises. The caller checks the connection type first.
 */
export async function disconnectProvider(credentialId: string): Promise<void> {
  const result = await client().request("DELETE", `/api/credential/${encodeURIComponent(credentialId)}`);
  if (result.error) {
    throw apiError("disconnect", result.error.data.message);
  }
}

/**
 * Human-readable connection state for the detail view. Env connections name the variable
 * that supplies them so an operator can tell why a provider is already authenticated.
 */
export interface ConnectionSummary {
  connected: boolean;
  credentialId?: string;
  label?: string;
  envName?: string;
}

export function summarizeConnection(integration: ProviderIntegration): ConnectionSummary {
  const credential = integration.connections.find((connection) => connection.type === "credential");
  if (credential?.id) {
    return {
      connected: true,
      credentialId: credential.id,
      ...(credential.label ? { label: credential.label } : {}),
    };
  }

  const env = integration.connections.find((connection) => connection.type === "env");
  if (env?.name) {
    return { connected: true, envName: env.name };
  }

  return { connected: false };
}

/** Filter for the search box: id and display name, case and space insensitive. */
export function searchIntegrations(
  integrations: ProviderIntegration[],
  query: string,
  limit = 10,
): ProviderIntegration[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  return integrations
    .filter(
      (integration) =>
        integration.id.toLowerCase().includes(needle) ||
        integration.name.toLowerCase().includes(needle),
    )
    .slice(0, limit);
}
