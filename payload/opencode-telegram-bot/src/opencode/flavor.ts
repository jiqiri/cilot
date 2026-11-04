export type OpencodeFlavor = "v1" | "v2";

const V2_FLAVOR = "v2";

/**
 * Resolve the OpenCode API flavor from the raw environment value.
 *
 * Only an explicit `v2` selects the V2 adapter. Anything else, including an
 * unknown value, falls back to `v1` so a typo can never switch the runtime.
 */
export function resolveOpencodeFlavor(raw: string | undefined): OpencodeFlavor {
  if (!raw) {
    return "v1";
  }

  return raw.trim().toLowerCase() === V2_FLAVOR ? "v2" : "v1";
}

export const opencodeFlavor: OpencodeFlavor = resolveOpencodeFlavor(
  process.env.OPENCODE_API_FLAVOR,
);
