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
 *   2. Per-hostname permission: preapproved docs/code domains auto-allow; any
 *      other host follows the allow policy (see below), which by default asks
 *      once per session.
 *
 * Host allow policy (non-preapproved hosts) — set "webfetchAllow" in
 *   ~/.pi/agent/pi-websearch.json or the PI_WEBFETCH_ALLOW env var:
 *   - "ask"    (default): Yes / Always / No dialog; "Always" persists the choice.
 *   - "always" : never prompt, fetch freely.
 *   - "never"  : block non-preapproved hosts.
 *
 * Environment:
 *   PI_WEBFETCH_BACKEND = playwright | w3m   (default: playwright)
 *   PI_WEBFETCH_ALLOW   = ask | always | never (default: ask)
 *   PI_WEBFETCH_MODEL   = provider/id        (agent picks the lightest if unset)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePolicy, savePersistedPolicy } from "./allow-config.ts";
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

    // 2. Host allow policy for non-preapproved hosts.
    const policy = resolvePolicy();
    if (policy === "always") {
      allowedHosts.add(host);
      return;
    }
    if (policy === "never") {
      return {
        block: true,
        reason: `WebFetch is not allowed for ${host} (policy: never). Set webfetchAllow="ask" in ~/.pi/agent/pi-websearch.json to be asked per host.`,
      };
    }

    if (!ctx.hasUI) return; // headless: nobody to ask, allow through

    // "ask": Yes for this session, Always persists the policy, No blocks.
    const choice = await ctx.ui.select(
      "Allow WebFetch?",
      [
        `Yes — allow ${host} for this session`,
        `Always — never ask again (persist)`,
        `No — block ${host}`,
      ],
    );
    if (choice === undefined) {
      // Dialog dismissed — treat as No.
      return { block: true, reason: `WebFetch denied for ${host}` };
    }
    if (choice.startsWith("Always")) {
      savePersistedPolicy("always");
      ctx.ui.notify("WebFetch now allows all hosts (webfetchAllow=always)", "info");
      return;
    }
    if (choice.startsWith("Yes")) {
      allowedHosts.add(host);
      return;
    }
    return { block: true, reason: `WebFetch denied for ${host}` };
  });
}
