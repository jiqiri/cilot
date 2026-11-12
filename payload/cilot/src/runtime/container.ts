import { existsSync } from "node:fs";

export const CILOT_CONTAINER_ENV = "CILOT_CONTAINER";

export interface ContainerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  dockerEnvExists?: () => boolean;
}

function isEnabledFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function isContainerRuntime(options?: ContainerRuntimeOptions): boolean {
  const env = options?.env ?? process.env;
  if (isEnabledFlag(env[CILOT_CONTAINER_ENV])) {
    return true;
  }

  const dockerEnvExists = options?.dockerEnvExists ?? (() => existsSync("/.dockerenv"));
  return dockerEnvExists();
}
