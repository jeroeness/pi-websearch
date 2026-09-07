/**
 * The extension's persisted config file (`~/.pi/agent/pi-websearch.json`).
 *
 * Global (account-scoped) — both the WebFetch summarization model (`model`) and
 * the host allow policy (`webfetchAllow`) live here, so every read/write merges
 * the JSON object instead of overwriting it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function configPath(): string {
	return join(getAgentDir(), "pi-websearch.json");
}

/** Read the config file as an object ({} if missing/corrupt). */
export function readConfig(): Record<string, unknown> {
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

/** Set one key in the config file, preserving the others. */
export function updateConfig(key: string, value: unknown): void {
	const path = configPath();
	const config = readConfig();
	config[key] = value;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
