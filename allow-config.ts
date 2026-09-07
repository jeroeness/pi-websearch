/**
 * WebFetch host-permission policy configuration.
 *
 * Policy controls what happens for hosts that are not on the preapproved
 * docs/code allowlist:
 *   "ask"    — confirm with the user (default)
 *   "always" — allow without asking
 *   "never"  — block
 *
 * Resolution order:
 *   1. Env var PI_WEBFETCH_ALLOW (highest priority)
 *   2. Persisted `webfetchAllow` in ~/.pi/agent/pi-websearch.json
 *   3. "ask"
 *
 * An in-session choice ("Always" in the confirm dialog) outranks both — see
 * `index.ts`, which holds that session state next to the approved-host set.
 */

import { readConfig, updateConfig } from "./config-file.ts";

export type WebFetchAllowPolicy = "ask" | "always" | "never";

const ENV_VAR = "PI_WEBFETCH_ALLOW";
const VALID: readonly WebFetchAllowPolicy[] = ["ask", "always", "never"];

function asPolicy(value: unknown): WebFetchAllowPolicy | undefined {
	return typeof value === "string" && VALID.includes(value as WebFetchAllowPolicy)
		? (value as WebFetchAllowPolicy)
		: undefined;
}

/** The persisted policy, if set to a valid value. */
export function loadPersistedPolicy(): WebFetchAllowPolicy | undefined {
	return asPolicy(readConfig().webfetchAllow);
}

/** Persist the policy, merging with existing config keys. */
export function savePersistedPolicy(policy: WebFetchAllowPolicy): void {
	updateConfig("webfetchAllow", policy);
}

/** Effective policy: env var > persisted > "ask". */
export function resolvePolicy(): WebFetchAllowPolicy {
	return asPolicy(process.env[ENV_VAR]?.trim().toLowerCase()) ?? loadPersistedPolicy() ?? "ask";
}
