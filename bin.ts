/**
 * External-binary resolution.
 *
 * Freshly-installed Homebrew binaries may not be on the PATH of an
 * already-running pi process, so we try `which` first (honours the launching
 * shell's PATH) and then fall back to well-known install locations.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

/** Standard fallback locations for a CLI tool of the given name. */
export function defaultBinFallbacks(name: string): string[] {
	return BIN_DIRS.map((dir) => `${dir}/${name}`);
}

/**
 * Resolve a binary to an absolute path, or `undefined` if it cannot be found.
 */
export function resolveBin(name: string, fallbacks: string[] = defaultBinFallbacks(name)): string | undefined {
	try {
		const out = execFileSync("which", [name], { encoding: "utf8" }).trim();
		const first = out.split("\n")[0]?.trim();
		if (first && existsSync(first)) return first;
	} catch {
		// `which` returned non-zero (not found) — fall through to explicit paths.
	}
	for (const candidate of fallbacks) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}
