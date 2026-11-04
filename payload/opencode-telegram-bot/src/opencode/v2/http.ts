export interface OpencodeV2Error {
  name: string;
  data: {
    message: string;
  };
}

export interface OpencodeV2Result<T> {
  data?: T;
  error?: OpencodeV2Error;
}

export interface OpencodeV2HttpOptions {
  baseUrl: string;
  username: string;
  password?: string;
}

export type OpencodeV2QueryValue = string | number | boolean | undefined;

export interface OpencodeV2RequestOptions {
  query?: Record<string, OpencodeV2QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
}

type FetchLike = typeof fetch;

const NETWORK_ERROR_NAME = "OpencodeV2NetworkError";
const HTTP_ERROR_NAME = "OpencodeV2ApiError";

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Minimal HTTP client for the OpenCode V2 API.
 *
 * The V2 server exposes REST under `/api/*` with Basic authentication and
 * streams server-sent events. This class keeps that protocol in one place so
 * the adapter can stay free of transport concerns.
 */
export class OpencodeV2Http {
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly options: OpencodeV2HttpOptions,
    fetchImpl: FetchLike = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  private buildHeaders(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {};

    if (this.options.password) {
      const credentials = `${this.options.username}:${this.options.password}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    }

    if (hasBody) {
      headers["Content-Type"] = "application/json";
    }

    return headers;
  }

  private buildUrl(path: string, query?: Record<string, OpencodeV2QueryValue>): string {
    const url = new URL(path, this.options.baseUrl);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }

    return url.toString();
  }

  async request<T>(
    method: string,
    path: string,
    options: OpencodeV2RequestOptions = {},
  ): Promise<OpencodeV2Result<T>> {
    const hasBody = options.body !== undefined;

    try {
      const init: RequestInit = {
        method,
        headers: this.buildHeaders(hasBody),
      };
      if (hasBody) {
        init.body = JSON.stringify(options.body);
      }
      if (options.signal) {
        init.signal = options.signal;
      }

      const response = await this.fetchImpl(this.buildUrl(path, options.query), init);

      if (!response.ok) {
        const message = (await response.text()).trim();
        return {
          error: {
            name: HTTP_ERROR_NAME,
            data: { message: message || response.statusText },
          },
        };
      }

      if (response.status === 204) {
        return {};
      }

      const text = await response.text();
      if (!text) {
        return {};
      }
      return { data: JSON.parse(text) as T };
    } catch (error) {
      return {
        error: {
          name: NETWORK_ERROR_NAME,
          data: { message: toErrorMessage(error) },
        },
      };
    }
  }

  /**
   * Subscribe to the server event stream. Yields each decoded `data:` payload.
   */
  async *stream(path: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    const init: RequestInit = {
      method: "GET",
      headers: { ...this.buildHeaders(false), Accept: "text/event-stream" },
    };
    if (signal) {
      init.signal = signal;
    }

    const response = await this.fetchImpl(this.buildUrl(path), init);

    if (!response.ok || !response.body) {
      throw new Error(`Event stream failed with status ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf("\n");

          if (line === "") {
            if (dataLines.length > 0) {
              const payload = dataLines.join("\n");
              dataLines = [];
              yield JSON.parse(payload);
            }
            continue;
          }

          if (line.startsWith(":")) {
            continue;
          }

          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
