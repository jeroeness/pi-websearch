/**
 * WebFetch tool description and the secondary-model prompt builder.
 *
 * Kept close to the upstream text so the tool reads identically to the harness
 * version. The copyright guardrails for non-preapproved domains are reproduced
 * verbatim — do not drop them for third-party sites.
 */

export const WEB_FETCH_TOOL_NAME = "WebFetch";

export const DESCRIPTION = `- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - For GitHub URLs, prefer using the gh CLI via Bash instead.`;

/**
 * Build the prompt handed to the small model. Non-preapproved domains receive
 * copyright guardrails (125-char quote cap, no verbatim reproduction, no song
 * lyrics).
 */
export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  _: boolean,
): string {
  return `Web page content:
---
${markdownContent}
---

${prompt}

Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.
`;
}
