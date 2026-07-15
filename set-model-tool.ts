/**
 * set_webfetch_model tool.
 *
 * Lets the agent configure the model WebFetch uses for its summarization step.
 * Called after the agent inspects available models (see model-config.ts and the
 * blocked-WebFetch instruction) and judges the lightest-class one. Validates the
 * choice against the available models, sets PI_WEBFETCH_MODEL for the session,
 * and persists it globally for future sessions.
 */

import { Type } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { findAvailableModel, formatAvailableModels, setSessionModel } from "./model-config.ts";

export const SET_WEBFETCH_MODEL_TOOL_NAME = "set_webfetch_model";

const parameters = Type.Object({
	model: Type.String({
		description:
			'The model WebFetch should use, as "provider/id" exactly as shown by pi --list-models (e.g. "github-copilot/claude-haiku-4.5"). Choose the lightest-class (cheapest/fastest) available model.',
	}),
});

interface SetModelDetails {
	model: string;
	ok: boolean;
}

export const SetWebfetchModelTool = defineTool({
	name: SET_WEBFETCH_MODEL_TOOL_NAME,
	label: "Set WebFetch Model",
	description:
		'Set the small/fast model WebFetch uses to summarize fetched pages. Sets PI_WEBFETCH_MODEL for this session and persists it for future sessions. Provide the model as "provider/id" exactly as listed by pi --list-models; choose the lightest-class (cheapest/fastest) available model.',
	promptSnippet: "Configure the model WebFetch uses to summarize fetched pages",
	promptGuidelines: [
		"Call set_webfetch_model with a lightest-class \"provider/id\" model when WebFetch reports that PI_WEBFETCH_MODEL is unset or invalid, then retry WebFetch.",
	],
	parameters,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<SetModelDetails>> {
		const spec = params.model.trim();
		const model = findAvailableModel(ctx.modelRegistry, spec);
		if (!model) {
			throw new Error(
				`"${spec}" is not an available model. Provide "provider/id" exactly as listed. Available models:\n${formatAvailableModels(ctx.modelRegistry)}`,
			);
		}
		setSessionModel(spec);
		return {
			content: [
				{
					type: "text",
					text: `WebFetch model set to ${spec} for this session and persisted for future sessions. Retry your WebFetch call.`,
				},
			],
			details: { model: spec, ok: true },
		};
	},

	renderResult(result, _options, theme) {
		const details = result.details as SetModelDetails | undefined;
		const label = details?.ok ? `WebFetch model → ${details.model}` : "WebFetch model unchanged";
		return new Text(theme.fg("muted", label), 0, 0);
	},
});
