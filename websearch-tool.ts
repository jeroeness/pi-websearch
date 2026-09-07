/**
 * WebSearch tool.
 *
 * Adapts the Claude Code WebSearch tool to pi's extension API. Backed locally
 * by the `ddgr` DuckDuckGo CLI rather than a server-side search tool, but the
 * model-facing output string is byte-for-byte the upstream format:
 *
 *   Web search results for query: "<query>"
 *
 *   Links: [{"title":"…","url":"…"}, …]
 *
 *   <snippet commentary>
 */

import { Type } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { applyDomainFilters, runDdgr, type SearchHit } from "./ddgr.ts";

export const WEB_SEARCH_TOOL_NAME = "WebSearch";

/** One search's link block, matching the upstream `SearchResult` shape. */
export type SearchResult = { tool_use_id: string; content: SearchHit[] };

function getMonthYear(): string {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

function getWebSearchPrompt(): string {
  const currentMonthYear = getMonthYear();
  return `- Allows the agent to search the web and use the results to inform responses
- Provides up-to-date information for current events and recent data
- Returns search result information formatted as search result blocks, including links as markdown hyperlinks
- Use this tool for accessing information beyond the model's knowledge cutoff
- Use correct year in search queries: The current month is ${currentMonthYear}. You must use this year when searching for recent information, documentation, or current events.
- Include sources at the the end:
\`
Sources:
- [Source Title 1](https://example.com/1)
- [Source Title 2](https://example.com/2)
\`
Usage notes:
  - Domain filtering is supported to include or block specific websites`;
}

const parameters = Type.Object({
  query: Type.String({ minLength: 2, description: "The search query to use" }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Only include search results from these domains",
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Never include search results from these domains",
    }),
  ),
});

interface WebSearchDetails {
  query: string;
  resultCount: number;
  durationSeconds: number;
  /** Total number of links found across the searches. */
  hits: number;
  /** DuckDuckGo rate-limited the search (transient; hits will be 0). */
  rateLimited: boolean;
}

/**
 * Flatten the mixed `(SearchResult | string)[]` into the upstream model-facing
 * string. Kept verbatim from the reference so consuming agents behave
 * identically.
 */
function formatOutput(
  query: string,
  results: (SearchResult | string)[],
): string {
  let out = `Web search results for query: "${query}"\n\n`;
  for (const result of results) {
    if (result == null) continue;
    if (typeof result === "string") {
      out += `${result}\n\n`;
    } else if (result.content.length > 0) {
      out += `Links: ${JSON.stringify(result.content)}\n\n`;
    } else {
      out += "No links found.\n\n";
    }
  }
  return out.trim();
}

export const WebSearchTool = defineTool({
  name: WEB_SEARCH_TOOL_NAME,
  label: "Web Search",
  description: getWebSearchPrompt(),
  promptSnippet: "Search the web (DuckDuckGo via ddgr) for current information",
  promptGuidelines: [
    "After using WebSearch, include a Sources: section listing the result URLs as markdown links.",
    "A search returning 0 results is a valid outcome, not a tool error — it means the query was too specific or restrictive. Retry with a broader or rephrased query rather than switching to other tools.",
  ],
  parameters,

  async execute(
    _toolCallId,
    params,
    signal,
    onUpdate,
  ): Promise<AgentToolResult<WebSearchDetails>> {
    const start = Date.now();
    const { query, allowed_domains, blocked_domains } = params;

    if (allowed_domains?.length && blocked_domains?.length) {
      throw new Error(
        "Cannot specify both allowed_domains and blocked_domains in the same request",
      );
    }

    onUpdate?.({
      content: [{ type: "text", text: `Searching: ${query}` }],
      details: {
        query,
        resultCount: 0,
        durationSeconds: 0,
        hits: 0,
        rateLimited: false,
      },
    });

    const effectiveQuery = applyDomainFilters(
      query,
      allowed_domains,
      blocked_domains,
    );

    // Ordered, mixed array — identical contract to the upstream parser output.
    const results: (SearchResult | string)[] = [];
    let searchFailed = false;
    let rateLimited = false;
    try {
      const ddgr = await runDdgr(effectiveQuery, signal);
      rateLimited = ddgr.rateLimited;
      results.push({ tool_use_id: `websearch-${start}`, content: ddgr.hits });
      if (ddgr.snippets.trim().length > 0) results.push(ddgr.snippets);
    } catch (e) {
      searchFailed = true;
      // A failed search becomes an error-string entry, matching upstream.
      results.push(`Web search error: ${(e as Error).message}`);
    }

    const durationSeconds = (Date.now() - start) / 1000;
    const resultCount = results.filter((r) => typeof r !== "string").length;
    const hits = results
      .filter((r) => typeof r !== "string")
      .reduce((n, r) => n + r.content.length, 0);

    let text = formatOutput(query, results);
    if (!searchFailed && hits === 0) {
      if (rateLimited) {
        text +=
          "\n\nThis search was rate-limited by DuckDuckGo (HTTP 202) — a transient server-side condition, not a query problem and not a tool error. Retry the same WebSearch query again in a moment.";
      } else {
        text +=
          "\n\nThis search ran successfully but found no pages. That is a normal outcome, not a tool error — it usually means the query is too specific or restrictive (exact-phrase quotes, rare names, domain filters). Retry WebSearch with a broader or rephrased query (e.g. drop the quotes, use just the surname, or remove filters) rather than switching to other tools.";
      }
    }

    return {
      content: [{ type: "text", text }],
      details: { query, resultCount, durationSeconds, hits, rateLimited },
    };
  },

  renderCall(args, theme, context) {
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    let content = theme.fg("toolTitle", theme.bold("WebSearch"));
    const query = typeof args?.query === "string" ? args.query : undefined;
    if (query) {
      content += ` ${theme.fg("dim", `"${query}"`)}`;
    }
    const allowed = Array.isArray(args?.allowed_domains) ? args.allowed_domains.length : 0;
    const blocked = Array.isArray(args?.blocked_domains) ? args.blocked_domains.length : 0;
    if (allowed > 0) content += ` ${theme.fg("muted", `(${allowed} domain${allowed === 1 ? "" : "s"} allowed)`)}`;
    if (blocked > 0) content += ` ${theme.fg("muted", `(${blocked} domain${blocked === 1 ? "" : "s"} blocked)`)}`;
    text.setText(content);
    return text;
  },

  renderResult(result, options, theme) {
    const details = result.details as WebSearchDetails | undefined;
    if (!details) return new Text("", 0, 0);
    // The query is already in the call row, so the in-progress line stays short.
    if (options.isPartial) return new Text(theme.fg("muted", "Searching…"), 0, 0);
    const n = details.resultCount;
    const empty = n > 0 && details.hits === 0;
    const suffix = !empty
      ? ""
      : details.rateLimited
        ? " · rate limited, retry"
        : " · no results";
    const label = `Did ${n} search${n === 1 ? "" : "es"} in ${details.durationSeconds.toFixed(1)}s${suffix}`;
    return new Text(theme.fg(suffix ? "warning" : "muted", label), 0, 0);
  },
});
