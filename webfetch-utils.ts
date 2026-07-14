/**
 * WebFetch retrieval pipeline: URL validation, a 15-minute LRU cache,
 * http->https upgrade, backend fetch, cross-host redirect detection, and
 * HTML->markdown conversion (turndown, with a tag-stripping fallback).
 */

import { LRUCache } from "lru-cache";
import { getFetchBackend, type PageContent } from "./backends.ts";
import { isPreapprovedHost } from "./preapproved.ts";

const MAX_URL_LENGTH = 2000;
export const MAX_MARKDOWN_LENGTH = 100_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;

type CacheEntry = {
	bytes: number;
	code: number;
	codeText: string;
	content: string;
	contentType: string;
};

const URL_CACHE = new LRUCache<string, CacheEntry>({
	maxSize: MAX_CACHE_SIZE_BYTES,
	ttl: CACHE_TTL_MS,
	sizeCalculation: (entry) => Math.max(1, Buffer.byteLength(entry.content)),
});

export function clearWebFetchCache(): void {
	URL_CACHE.clear();
}

export function isPreapprovedUrl(url: string): boolean {
	try {
		const p = new URL(url);
		return isPreapprovedHost(p.hostname, p.pathname);
	} catch {
		return false;
	}
}

/** Block loopback / link-local / private / cloud-metadata hosts (basic SSRF guard). */
function isBlockedHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}
	if (host === "::1" || host === "0.0.0.0" || host === "169.254.169.254") return true;
	const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (m) {
		const a = Number(m[1]);
		const b = Number(m[2]);
		if (a === 127 || a === 10 || a === 0) return true;
		if (a === 192 && b === 168) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
	}
	return false;
}

export function validateURL(url: string): boolean {
	if (url.length > MAX_URL_LENGTH) return false;
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.username || parsed.password) return false;
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	if (parsed.hostname.split(".").length < 2) return false;
	if (isBlockedHost(parsed.hostname)) return false;
	return true;
}

// Lazy HTML->markdown converter. Prefers turndown; falls back to a tag stripper
// so WebFetch still works if the dependency is unavailable.
type HtmlToMarkdown = (html: string) => string;
let converterPromise: Promise<HtmlToMarkdown> | undefined;

function getHtmlToMarkdown(): Promise<HtmlToMarkdown> {
	if (!converterPromise) {
		converterPromise = (async () => {
			try {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic import shape.
				const mod: any = await import("turndown");
				const Turndown = mod?.default ?? mod;
				const service = new Turndown();
				// Drop non-content nodes so their text doesn't leak into the markdown.
				service.remove(["script", "style", "noscript", "head"]);
				return (html: string) => service.turndown(html);
			} catch {
				return (html: string) =>
					html
						.replace(/<script[\s\S]*?<\/script>/gi, "")
						.replace(/<style[\s\S]*?<\/style>/gi, "")
						.replace(/<[^>]+>/g, " ")
						.replace(/\s+/g, " ")
						.trim();
			}
		})();
	}
	return converterPromise;
}

export type RedirectInfo = {
	type: "redirect";
	originalUrl: string;
	redirectUrl: string;
	statusCode: number;
};

export type FetchedContent = {
	type: "content";
	content: string; // markdown or plain text
	bytes: number;
	code: number;
	codeText: string;
	contentType: string;
};

function stripWww(host: string): string {
	return host.replace(/^www\./, "");
}

export async function getURLMarkdownContent(
	url: string,
	signal?: AbortSignal,
): Promise<FetchedContent | RedirectInfo> {
	if (!validateURL(url)) throw new Error(`Invalid or blocked URL: ${url}`);

	const cached = URL_CACHE.get(url);
	if (cached) return { type: "content", ...cached };

	// http -> https upgrade.
	const parsed = new URL(url);
	if (parsed.protocol === "http:") parsed.protocol = "https:";
	const upgradedUrl = parsed.toString();

	const backend = getFetchBackend();
	const page: PageContent = await backend.fetch(upgradedUrl, signal);

	// Surface cross-host redirects instead of silently following them.
	const requestedHost = stripWww(new URL(upgradedUrl).hostname);
	let finalHost = requestedHost;
	try {
		finalHost = stripWww(new URL(page.finalUrl).hostname);
	} catch {
		// Keep requestedHost if the backend returned a non-URL.
	}
	if (requestedHost !== finalHost) {
		return {
			type: "redirect",
			originalUrl: upgradedUrl,
			redirectUrl: page.finalUrl,
			statusCode: page.statusCode,
		};
	}

	const content = page.kind === "html" ? (await getHtmlToMarkdown())(page.content) : page.content;
	const entry: CacheEntry = {
		bytes: Buffer.byteLength(page.content),
		code: page.statusCode,
		codeText: page.statusText,
		content,
		contentType: page.contentType,
	};
	URL_CACHE.set(url, entry);
	return { type: "content", ...entry };
}
