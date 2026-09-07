/**
 * Local web search via the `ddgr` DuckDuckGo CLI.
 *
 * Mirrors the shape the upstream WebSearch parser produced: a list of
 * `{ title, url }` hits plus a joined snippet string used as model-visible
 * commentary.
 */

import { spawn } from "node:child_process";
import { resolveBin } from "./bin.ts";

export type SearchHit = { title: string; url: string };

export type DdgrResult = {
	hits: SearchHit[];
	/** Concatenated abstracts, used as the model-visible snippet text for a query. */
	snippets: string;
	/**
	 * DuckDuckGo rate-limited the request (HTTP 202 "Accepted" + no results).
	 * ddgr still exits 0, so callers must check this flag: zero hits with
	 * rateLimited=true is transient (retry after a pause), not a query problem.
	 */
	rateLimited: boolean;
};

// ddgr JSON element shape (as emitted by `ddgr --json`).
type DdgrHit = { abstract?: string; title: string; url: string };

// Number of results requested per ddgr invocation.
const DDGR_NUM = 10;
// Hard timeout for a single ddgr process — mirrors a search round-trip.
const DDGR_TIMEOUT_MS = 10_000;

/**
 * Translate allowed/blocked domain filters into DuckDuckGo query operators.
 * allowed -> `(site:a OR site:b)`; blocked -> `-site:x`. Never both (validated
 * by the caller).
 */
export function applyDomainFilters(query: string, allowed?: string[], blocked?: string[]): string {
	if (allowed?.length) {
		const clause = allowed.map((d) => `site:${d}`).join(" OR ");
		return `${query} (${clause})`;
	}
	if (blocked?.length) {
		const clause = blocked.map((d) => `-site:${d}`).join(" ");
		return `${query} ${clause}`;
	}
	return query;
}

/**
 * Run one ddgr search. Resolves to hits + a joined snippet string. Rejects on
 * non-zero exit, timeout, missing binary, or unparseable output.
 *
 * The query is passed as an argv element, never interpolated into a shell
 * string — do not switch this to `shell: true`.
 */
export function runDdgr(query: string, signal?: AbortSignal): Promise<DdgrResult> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const bin = resolveBin("ddgr");
		if (!bin) {
			reject(new Error("ddgr not found. Install with `brew install ddgr` or `pipx install ddgr`."));
			return;
		}

		const child = spawn(bin, ["--json", "--np", "--num", String(DDGR_NUM), "-r", "us-en", query], { signal });

		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), DDGR_TIMEOUT_MS);

		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`ddgr exited ${code}: ${stderr.trim()}`));
				return;
			}
			try {
				const raw = JSON.parse(stdout || "[]") as DdgrHit[];
				const hits = raw.map((h) => ({ title: h.title, url: h.url }));
				const snippets = raw
					.map((h) => (h.abstract ? `- ${h.title}: ${h.abstract}` : `- ${h.title}`))
					.join("\n");
				// DuckDuckGo rate limiting surfaces as "[ERROR] HTTP Error 202: Accepted"
				// on stderr with an empty result set (exit code 0).
				const rateLimited = /HTTP Error 202/i.test(stderr);
				resolve({ hits, snippets, rateLimited });
			} catch (e) {
				reject(new Error(`Failed to parse ddgr JSON: ${(e as Error).message}`));
			}
		});
	});
}
