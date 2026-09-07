/**
 * WebFetch summarization-model configuration.
 *
 * The model used for WebFetch's summarization step is chosen by the agent from
 * the models actually available in the session (what `pi --list-models` shows),
 * stored in `PI_WEBFETCH_MODEL` for the session and persisted globally so future
 * sessions reuse it. This module owns reading/validating/persisting that choice
 * and building the instruction the agent sees when it must pick one.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

type ModelRegistry = ExtensionContext["modelRegistry"];

const ENV_VAR = "PI_WEBFETCH_MODEL";

function persistPath(): string {
	// Global (account-scoped) — model availability follows the machine/account,
	// not the project. e.g. ~/.pi/agent/pi-websearch.json
	return join(getAgentDir(), "pi-websearch.json");
}

/** The model spec configured for this session (`provider/id`), if any. */
export function getConfiguredSpec(): string | undefined {
	const value = process.env[ENV_VAR]?.trim();
	return value ? value : undefined;
}

/** Read the shared config file as an object ({} if missing/corrupt). */
function readConfig(): Record<string, unknown> {
	try {
		const data = JSON.parse(readFileSync(persistPath(), "utf8")) as unknown;
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return data as Record<string, unknown>;
		}
	} catch {
		// Missing or corrupt — start fresh.
	}
	return {};
}

/** Read the persisted model spec from the global config file. */
export function loadPersistedSpec(): string | undefined {
	const value = readConfig().model;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Persist the model spec to the global config file for future sessions. */
export function savePersistedSpec(spec: string): void {
	const path = persistPath();
	mkdirSync(dirname(path), { recursive: true });
	// Merge, preserving other keys (e.g. webfetchAllow).
	const config = readConfig();
	config.model = spec;
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Set `PI_WEBFETCH_MODEL` for this session and persist it for future ones. */
export function setSessionModel(spec: string): void {
	process.env[ENV_VAR] = spec;
	try {
		savePersistedSpec(spec);
	} catch {
		// Non-fatal: the session is still configured even if the file is unwritable.
	}
}

/**
 * On session start, seed `PI_WEBFETCH_MODEL` from the persisted global choice
 * when the env var is not already set. An explicit env var always wins.
 */
export function hydrateFromPersisted(): void {
	if (getConfiguredSpec()) return;
	const persisted = loadPersistedSpec();
	if (persisted) process.env[ENV_VAR] = persisted;
}

function parseSpec(spec: string): { provider: string; id: string } | undefined {
	const idx = spec.indexOf("/");
	if (idx <= 0 || idx === spec.length - 1) return undefined;
	return { provider: spec.slice(0, idx), id: spec.slice(idx + 1) };
}

/** Resolve `provider/id` to an available model, or undefined if not available. */
export function findAvailableModel(registry: ModelRegistry, spec: string | undefined): Model<Api> | undefined {
	if (!spec) return undefined;
	const parsed = parseSpec(spec);
	if (!parsed) return undefined;
	return registry.getAvailable().find((m) => m.provider === parsed.provider && m.id === parsed.id);
}

/** The configured + available model for this session, if valid. */
export function resolveConfiguredModel(registry: ModelRegistry): Model<Api> | undefined {
	return findAvailableModel(registry, getConfiguredSpec());
}

/** Format a token count like `pi --list-models` (200000 -> "200K", 1e6 -> "1M"). */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

const MAX_LISTED = 80;

type Row = { spec: string; context: string; maxOut: string; thinking: string; images: string };

/** Render available models as a table mirroring `pi --list-models`. */
export function formatAvailableModels(registry: ModelRegistry): string {
	const models = [...registry.getAvailable()].sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		return providerCmp !== 0 ? providerCmp : a.id.localeCompare(b.id);
	});
	if (models.length === 0) return "(no models available — check provider authentication)";

	const shown = models.slice(0, MAX_LISTED);
	const rows: Row[] = shown.map((m) => ({
		spec: `${m.provider}/${m.id}`,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));
	const headers: Row = {
		spec: "provider/model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};
	const width = {
		spec: Math.max(headers.spec.length, ...rows.map((r) => r.spec.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: headers.thinking.length,
		images: headers.images.length,
	};
	const render = (r: Row) =>
		[
			r.spec.padEnd(width.spec),
			r.context.padEnd(width.context),
			r.maxOut.padEnd(width.maxOut),
			r.thinking.padEnd(width.thinking),
			r.images.padEnd(width.images),
		].join("  ");

	const lines = [render(headers), ...rows.map(render)];
	if (models.length > shown.length) {
		lines.push(`… and ${models.length - shown.length} more (run \`pi --list-models\`)`);
	}
	return lines.join("\n");
}

/**
 * The instruction shown to the agent (as a blocked-tool reason) when WebFetch
 * has no valid summarization model. It embeds the available-model list and asks
 * the agent to judge the lightest-class one and set it via set_webfetch_model.
 */
export function buildSelectionInstruction(registry: ModelRegistry, currentSpec: string | undefined): string {
	const problem = currentSpec
		? `The configured WebFetch model "${currentSpec}" (${ENV_VAR}) is not available in this session.`
		: `${ENV_VAR} is not set, so WebFetch has no model for its summarization step.`;

	return `${problem}

WebFetch needs a small, fast model to process fetched pages. Look at the available models below and choose the LIGHTEST-class one — the cheapest and fastest, typically a Haiku / mini / flash / small / lite / nano class model. Avoid heavy models ("opus", "pro", "max", "ultra", large parameter counts) and prefer "thinking: no".

Available models (provider/model):
${formatAvailableModels(registry)}

Then call the set_webfetch_model tool with your choice, for example:
  set_webfetch_model({ model: "<provider>/<model>" })
That sets ${ENV_VAR} for this session and persists it for future sessions. Once it succeeds, retry the WebFetch call.

Notes:
- You may run \`pi --list-models\` yourself to double-check what is available.
- Do NOT try to set ${ENV_VAR} with a bash \`export\` — that does not reach the agent process. Use the set_webfetch_model tool.`;
}
