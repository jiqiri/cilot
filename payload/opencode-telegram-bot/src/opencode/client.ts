import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { config } from "../config.js";
import { opencodeFlavor } from "./flavor.js";
import { createOpencodeV2Client } from "./v2/client.js";

const getAuth = () => {
  if (!config.opencode.password) {
    return undefined;
  }
  const credentials = `${config.opencode.username}:${config.opencode.password}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
};

function createClient(): ReturnType<typeof createOpencodeClient> {
  if (opencodeFlavor === "v2") {
    // The V2 adapter exposes the same flat-parameter surface the bot calls, but
    // its own payload types: cast once here so every call site stays unchanged.
    return createOpencodeV2Client({
      baseUrl: config.opencode.apiUrl,
      username: config.opencode.username,
      password: config.opencode.password,
    }) as unknown as ReturnType<typeof createOpencodeClient>;
  }

  return createOpencodeClient({
    baseUrl: config.opencode.apiUrl,
    headers: config.opencode.password ? { Authorization: getAuth() } : undefined,
  });
}

export const opencodeClient = createClient();
