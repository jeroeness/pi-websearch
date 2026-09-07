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
 * The persisted file is shared with the WebFetch model config (which stores
 * `model`), so all reads/writes merge the JSON object instead of overwriting.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type WebFetchAllowPolicy = "ask" | "always" | "never";

const ENV_VAR = "PI_WEBFETCH_ALLOW";
const VALID: readonly WebFetchAllowPolicy[] = ["ask", "always", "never"];

function configPath(): string {
	// Global (account-scoped) — same file as the WebFetch model config.
	return join(getAgentDir(), "pi-websearch.json");
}

/** Read the shared config file as an object ({} if missing/corrupt). */
function readConfig(): Record<string, unknown> {
	try {
		const data = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return data as Record<string, unknown>;
		}
	} catch {
		// Missing or corrupt — start fresh.
	}
	return {};
}

/** Write the shared config file, preserving existing keys. */
function writeConfig(config: Record<string, unknown>): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** The persisted policy, if set to a valid value. */
export function loadPersistedPolicy(): WebFetchAllowPolicy | undefined {
	const value = readConfig().webfetchAllow;
	return VALID.includes(value as WebFetchAllowPolicy)
		? (value as WebFetchAllowPolicy)
		: undefined;
}

/** Persist the policy, merging with existing config keys. */
export function savePersistedPolicy(policy: WebFetchAllowPolicy): void {
	const config = readConfig();
	config.webfetchAllow = policy;
	writeConfig(config);
}

/** Effective policy: env var > persisted > "ask". */
export function resolvePolicy(): WebFetchAllowPolicy {
	const env = process.env[ENV_VAR]?.trim().toLowerCase() as
		| WebFetchAllowPolicy
		| undefined;
	if (env && VALID.includes(env)) return env;
	return loadPersistedPolicy() ?? "ask";
}
