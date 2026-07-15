/**
 * WebFetch secondary-model step.
 *
 * Applies the caller's prompt to the fetched content using the model configured
 * in PI_WEBFETCH_MODEL (see model-config.ts — chosen by the agent from the
 * available models). Falls back to the current session model, then to returning
 * the truncated content directly when no model / API key is available.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfiguredModel } from "./model-config.ts";
import { makeSecondaryModelPrompt } from "./webfetch-prompt.ts";
import { MAX_MARKDOWN_LENGTH } from "./webfetch-utils.ts";

export async function applyPromptToMarkdown(
	ctx: ExtensionContext,
	prompt: string,
	markdownContent: string,
	signal: AbortSignal | undefined,
	isPreapprovedDomain: boolean,
): Promise<string> {
	const truncated =
		markdownContent.length > MAX_MARKDOWN_LENGTH
			? `${markdownContent.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[Content truncated due to length...]`
			: markdownContent;

	// Normally guaranteed valid by the tool_call gate; fall back to the session
	// model, then to the raw content, so WebFetch degrades gracefully.
	const model = resolveConfiguredModel(ctx.modelRegistry) ?? ctx.model;
	if (!model) return truncated;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) return truncated;

	const modelPrompt = makeSecondaryModelPrompt(truncated, prompt, isPreapprovedDomain);
	const response = await complete(
		model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: modelPrompt }],
					timestamp: Date.now(),
				},
			],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
	);

	if (signal?.aborted) throw new Error("aborted");

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
	return text || "No response from model";
}
