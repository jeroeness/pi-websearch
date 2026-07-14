/**
 * WebSearch extension.
 *
 * Registers two tools that mirror the Claude Code harness's web tools, adapted
 * to pi's extension API:
 *
 *   - WebSearch : local DuckDuckGo search via the `ddgr` CLI. Output string is
 *                 byte-for-byte the upstream format (Links + Sources reminder).
 *   - WebFetch  : URL retrieval via a pluggable backend (Playwright default,
 *                 w3m fallback) + HTML->markdown + a small-model summarization
 *                 step. Returns the processed result string only.
 *
 * WebFetch is gated per-hostname: preapproved docs/code domains auto-allow, and
 * anything else prompts once per session (persisted for the session only).
 *
 * Environment:
 *   PI_WEBFETCH_BACKEND = playwright | w3m   (default: playwright)
 *   PI_WEBFETCH_MODEL   = provider/id        (default: anthropic/claude-haiku-4-5)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isPreapprovedHost } from "./preapproved.ts";
import { WEB_FETCH_TOOL_NAME } from "./webfetch-prompt.ts";
import { WebFetchTool } from "./webfetch-tool.ts";
import { WebSearchTool } from "./websearch-tool.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool(WebSearchTool);
	pi.registerTool(WebFetchTool);

	// Hostnames the user approved for WebFetch during this session.
	const allowedHosts = new Set<string>();
	pi.on("session_start", () => {
		allowedHosts.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== WEB_FETCH_TOOL_NAME) return;

		const raw = (event.input as { url?: string }).url;
		if (!raw) return; // invalid input is reported by the tool's own validation

		let host: string;
		try {
			const parsed = new URL(raw);
			host = parsed.hostname;
			if (isPreapprovedHost(parsed.hostname, parsed.pathname)) return; // auto-allow docs/code domains
		} catch {
			return; // let the tool surface the parse error
		}

		if (allowedHosts.has(host)) return;
		if (!ctx.hasUI) return; // headless: nobody to ask, allow through

		const ok = await ctx.ui.confirm("Allow WebFetch?", `Fetch content from ${host}?`);
		if (!ok) return { block: true, reason: `WebFetch denied for ${host}` };
		allowedHosts.add(host);
	});
}
