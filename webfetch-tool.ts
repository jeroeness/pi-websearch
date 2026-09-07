/**
 * WebFetch tool.
 *
 * Adapts the Claude Code WebFetch tool to pi's extension API. Retrieval uses a
 * pluggable backend (Playwright default, w3m fallback); HTML is converted to
 * markdown and processed by a small model per the caller's prompt. The
 * model-facing output is the processed `result` string only, matching upstream.
 *
 * Per-hostname permission is enforced in `index.ts` via a `tool_call` gate.
 */

import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { applyPromptToMarkdown } from "./webfetch-model.ts";
import { DESCRIPTION, WEB_FETCH_TOOL_NAME } from "./webfetch-prompt.ts";
import { getURLMarkdownContent, isPreapprovedUrl, MAX_MARKDOWN_LENGTH } from "./webfetch-utils.ts";

const AUTH_WARNING =
	"IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs. Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub). If so, look for a specialized MCP tool that provides authenticated access.";

const parameters = Type.Object({
	url: Type.String({ description: "The URL to fetch content from" }),
	prompt: Type.String({ description: "The prompt to run on the fetched content" }),
});

interface WebFetchDetails {
	bytes: number;
	code: number;
	codeText: string;
	durationMs: number;
	url: string;
}

function statusTextFor(code: number): string {
	switch (code) {
		case 301:
			return "Moved Permanently";
		case 308:
			return "Permanent Redirect";
		case 307:
			return "Temporary Redirect";
		default:
			return "Found";
	}
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/** Strip Playwright's "Call log:" section from an error message (pure noise here). */
function stripCallLog(message: string): string {
	const idx = message.indexOf("Call log:");
	return (idx >= 0 ? message.slice(0, idx) : message).trim();
}

/**
 * Map a fetch failure to a short human/model-facing hint so the error text is
 * actionable instead of a bare browser message.
 */
function failureAdvice(message: string): string {
	const m = message.toLowerCase();
	if (m.includes("err_cert_authority_invalid") || m.includes("err_ssl") || m.includes("certificate")) {
		return (
			"This site's TLS certificate failed validation (expired, self-signed, or mismatched), " +
			"so the browser refused to load it. Workaround: try the plain-HTTP version of the URL, " +
			"or rely on search-result snippets for this site."
		);
	}
	if (m.includes("timeoutexceeded") || m.includes("timeout") || m.includes("timed out")) {
		return (
			"The page did not load within the timeout. It may be slow, blocking headless browsers, " +
			"or unreachable. Retry once, or fall back to search-result snippets."
		);
	}
	if (m.includes("navigating")) {
		return (
			"The page kept client-side navigating (common on sites with heavy JS redirects) and never " +
			"settled. Workaround: fetch a more specific URL on the same host, or use search-result snippets."
		);
	}
	if (
		m.includes("net::err_name_not_resolved") ||
		m.includes("enotfound") ||
		m.includes("eai_again")
	) {
		return "DNS lookup failed — the hostname does not resolve. Check the URL spelling.";
	}
	if (
		m.includes("net::err_connection_refused") ||
		m.includes("net::err_connection_reset") ||
		m.includes("net::err_connection_aborted") ||
		m.includes("econnrefused") ||
		m.includes("econnreset")
	) {
		return "The server refused or reset the connection. The site may be down or blocking automated clients.";
	}
	if (m.includes("net::err_tunnel_failed") || m.includes("proxy")) {
		return "A proxy blocked the request. Check proxy configuration for this host.";
	}
	if (m.includes("aborted")) {
		return "The fetch was aborted (cancelled by a newer request or the user).";
	}
	return "If the error persists, rely on search-result snippets for this URL.";
}

export const WebFetchTool = defineTool({
	name: WEB_FETCH_TOOL_NAME,
	label: "Fetch",
	description: `${AUTH_WARNING}\n${DESCRIPTION}`,
	promptSnippet: "Fetch a URL and extract content with a small model",
	promptGuidelines: [
		"Use WebFetch to retrieve and analyze the content of a specific URL.",
		"For GitHub URLs, prefer the gh CLI via Bash (gh pr view, gh issue view, gh api).",
	],
	parameters,

	async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<WebFetchDetails>> {
		const start = Date.now();
		const { url, prompt } = params;

		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			throw new Error(`Invalid URL "${url}". The URL provided could not be parsed.`);
		}

		onUpdate?.({
			content: [{ type: "text", text: `Fetching ${host}` }],
			details: { bytes: 0, code: 0, codeText: "", durationMs: 0, url },
		});

		let response;
		try {
			response = await getURLMarkdownContent(url, signal);
		} catch (e) {
			// Surface a descriptive, actionable error instead of re-throwing a bare
			// browser message (which would render as "undefined · NaN KB" in the TUI).
			const msg = stripCallLog(e instanceof Error ? e.message : String(e));
			const text = `Failed to fetch ${url}: ${msg}\n\n${failureAdvice(msg)}`;
			return {
				content: [{ type: "text", text }],
				details: {
					bytes: 0,
					code: 0,
					codeText: "error",
					durationMs: Date.now() - start,
					url,
				},
			};
		}

		// Cross-host redirect -> tell the model to re-fetch (verbatim protocol).
		if (response.type === "redirect") {
			const statusText = statusTextFor(response.statusCode);
			const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`;
			return {
				content: [{ type: "text", text: message }],
				details: {
					bytes: Buffer.byteLength(message),
					code: response.statusCode,
					codeText: statusText,
					durationMs: Date.now() - start,
					url,
				},
			};
		}

		const { content, bytes, code, codeText, contentType } = response;
		const isPreapproved = isPreapprovedUrl(url);

		let result: string;
		if (isPreapproved && contentType.includes("text/markdown") && content.length < MAX_MARKDOWN_LENGTH) {
			result = content; // raw passthrough fast path
		} else {
			result = await applyPromptToMarkdown(ctx, prompt, content, signal, isPreapproved);
		}

		return {
			content: [{ type: "text", text: result }],
			details: { bytes, code, codeText, durationMs: Date.now() - start, url },
		};
	},

	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		let content = theme.fg("toolTitle", theme.bold("WebFetch"));
		const url = typeof args?.url === "string" ? args.url : undefined;
		if (url) content += ` ${theme.fg("dim", url)}`;
		text.setText(content);
		return text;
	},

	renderResult(result, _options, theme, context) {
		const details = result.details as WebFetchDetails | undefined;
		// Error results created by the harness carry no details — recover the URL
		// from the call args so the line is informative instead of "undefined".
		const url =
			details?.url ??
			(typeof context.args?.url === "string" ? (context.args.url as string) : "");
		const host = url ? hostOf(url) : "(unknown URL)";

		const errorText = (result.content?.find((c) => c.type === "text") as { text?: string } | undefined)?.text;

		// Failed fetch (harness error, or our own error result marked codeText="error").
		const isError = context.isError || (details ? details.codeText === "error" : true);
		if (isError) {
			const msg = errorText ?? "Fetch failed";
			const firstLine = msg.split("\n")[0].slice(0, 300);
			const prefix = theme.fg("error", `✗ ${host} · `);
			const body = context.expanded ? msg : firstLine;
			return new Text(prefix + theme.fg("error", body), 0, 0);
		}

		const kb = (details!.bytes / 1024).toFixed(1);
		const ok = details!.code >= 200 && details!.code < 400;
		const codeLabel = `${details!.code}${details!.codeText ? ` ${details!.codeText}` : ""}`;
		const line = `${host} · ${codeLabel} · ${kb} KB · ${details!.durationMs}ms`;
		return new Text(theme.fg(ok ? "muted" : "warning", line), 0, 0);
	},
});
