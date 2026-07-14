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

		let host = url;
		try {
			host = new URL(url).hostname;
		} catch {
			throw new Error(`Invalid URL "${url}". The URL provided could not be parsed.`);
		}

		onUpdate?.({
			content: [{ type: "text", text: `Fetching ${host}` }],
			details: { bytes: 0, code: 0, codeText: "", durationMs: 0, url },
		});

		const response = await getURLMarkdownContent(url, signal);

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

	renderResult(result, _options, theme) {
		const details = result.details as WebFetchDetails | undefined;
		if (!details) return new Text("", 0, 0);
		let host = details.url;
		try {
			host = new URL(details.url).hostname;
		} catch {
			// keep the raw url
		}
		const kb = (details.bytes / 1024).toFixed(1);
		return new Text(theme.fg("muted", `Fetched ${host} · ${kb} KB · ${details.durationMs}ms`), 0, 0);
	},
});
