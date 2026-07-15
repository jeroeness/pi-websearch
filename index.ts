/**
 * WebSearch extension.
 *
 * Registers tools that mirror the Claude Code harness's web tools, adapted to
 * pi's extension API:
 *
 *   - WebSearch          : local DuckDuckGo search via the `ddgr` CLI.
 *   - WebFetch           : URL retrieval via a pluggable backend (Playwright
 *                          default, w3m fallback) + HTML->markdown + a
 *                          small-model summarization step.
 *   - set_webfetch_model : lets the agent configure the summarization model.
 *
 * Before WebFetch runs it is gated on two things:
 *   1. A valid summarization model (PI_WEBFETCH_MODEL). If unset/invalid, the
 *      call is blocked with the list of available models and an instruction for
 *      the agent to pick the lightest-class one and call set_webfetch_model. The
 *      choice is persisted globally (~/.pi/agent/pi-websearch.json) for reuse.
 *   2. Per-hostname permission: preapproved docs/code domains auto-allow;
 *      anything else asks once per session.
 *
 * Environment:
 *   PI_WEBFETCH_BACKEND = playwright | w3m   (default: playwright)
 *   PI_WEBFETCH_MODEL   = provider/id        (agent picks the lightest if unset)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildSelectionInstruction,
  getConfiguredSpec,
  hydrateFromPersisted,
  resolveConfiguredModel,
} from "./model-config.ts";
import { isPreapprovedHost } from "./preapproved.ts";
import { SetWebfetchModelTool } from "./set-model-tool.ts";
import { WEB_FETCH_TOOL_NAME } from "./webfetch-prompt.ts";
import { WebFetchTool } from "./webfetch-tool.ts";
import { WebSearchTool } from "./websearch-tool.ts";

export default function (pi: ExtensionAPI) {
  pi.registerTool(WebSearchTool);
  pi.registerTool(WebFetchTool);
  pi.registerTool(SetWebfetchModelTool);

  // Hostnames the user approved for WebFetch during this session.
  const allowedHosts = new Set<string>();
  pi.on("session_start", () => {
    allowedHosts.clear();
    // Seed PI_WEBFETCH_MODEL from the persisted global choice, if any.
    hydrateFromPersisted();
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== WEB_FETCH_TOOL_NAME) return;

    const raw = (event.input as { url?: string }).url;
    if (!raw) return; // invalid input is reported by the tool's own validation

    // 1. Ensure WebFetch has a valid summarization model. If none is configured
    // (and there are models to choose from), block and ask the agent to pick the
    // lightest-class one via set_webfetch_model. Runs for every URL, including
    // preapproved ones, so the model is configured before any fetch.
    if (
      !resolveConfiguredModel(ctx.modelRegistry) &&
      ctx.modelRegistry.getAvailable().length > 0
    ) {
      return {
        block: true,
        reason: buildSelectionInstruction(
          ctx.modelRegistry,
          getConfiguredSpec(),
        ),
      };
    }

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

    const ok = await ctx.ui.confirm(
      "Allow WebFetch?",
      `Fetch content from ${host}?`,
    );
    if (!ok) return { block: true, reason: `WebFetch denied for ${host}` };
    allowedHosts.add(host);
  });
}
