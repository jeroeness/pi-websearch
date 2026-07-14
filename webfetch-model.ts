/**
 * WebFetch secondary-model step.
 *
 * Applies the caller's prompt to the fetched content using a small, fast model
 * (default `anthropic/claude-haiku-4-5`, override with PI_WEBFETCH_MODEL as
 * `provider/id`). Falls back to the current session model, then to returning
 * the truncated content directly when no model/API key is available.
 */

import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { makeSecondaryModelPrompt } from "./webfetch-prompt.ts";
import { MAX_MARKDOWN_LENGTH } from "./webfetch-utils.ts";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL_ID = "claude-haiku-4-5";

// getModel's model-id parameter is typed per-provider; we resolve from runtime
// strings (env / defaults), so use a loosened view of the same function.
const lookupModel = getModel as (provider: string, id: string) => ReturnType<typeof getModel>;

function resolveModel(ctx: ExtensionContext) {
	const configured = process.env.PI_WEBFETCH_MODEL;
	if (configured?.includes("/")) {
		const [provider, ...rest] = configured.split("/");
		const model = lookupModel(provider, rest.join("/"));
		if (model) return model;
	}
	return lookupModel(DEFAULT_PROVIDER, DEFAULT_MODEL_ID) ?? ctx.model;
}

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

	const model = resolveModel(ctx);
	// Graceful degradation: with no usable model, return the content directly.
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
