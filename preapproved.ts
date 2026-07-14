/**
 * Preapproved hosts for WebFetch.
 *
 * These docs/code domains skip the per-hostname permission prompt and also
 * drive the raw-passthrough content path (preapproved + text/markdown + short
 * -> returned without a model in the loop). Subdomains are covered
 * automatically (e.g. `docs.python.org` matches `python.org`).
 */

const PREAPPROVED_HOSTS = new Set<string>([
	// JS / web platform
	"developer.mozilla.org",
	"mozilla.org",
	"nodejs.org",
	"bun.sh",
	"deno.com",
	"deno.land",
	"npmjs.com",
	"typescriptlang.org",
	"react.dev",
	"vuejs.org",
	"angular.io",
	"svelte.dev",
	"web.dev",
	"developer.chrome.com",
	"w3.org",
	"whatwg.org",
	"jestjs.io",
	"vitest.dev",
	"playwright.dev",
	"json.org",
	// Languages / runtimes
	"python.org",
	"pypi.org",
	"rust-lang.org",
	"go.dev",
	"golang.org",
	"ruby-lang.org",
	"php.net",
	"llvm.org",
	"cppreference.com",
	"gcc.gnu.org",
	"gnu.org",
	"kernel.org",
	"man7.org",
	// Data / ML
	"tensorflow.org",
	"pytorch.org",
	"scikit-learn.org",
	"numpy.org",
	"pandas.pydata.org",
	"huggingface.co",
	// Databases / infra
	"postgresql.org",
	"mysql.com",
	"redis.io",
	"mongodb.com",
	"sqlite.org",
	"docker.com",
	"kubernetes.io",
	// Clouds / vendor docs
	"learn.microsoft.com",
	"docs.microsoft.com",
	"dotnet.microsoft.com",
	"docs.oracle.com",
	"docs.aws.amazon.com",
	"cloud.google.com",
	"developer.android.com",
	"developer.apple.com",
	// Hosting / OSS ecosystems
	"github.com",
	"docs.github.com",
	"github.io",
	"gitlab.com",
	"docs.gitlab.com",
	"readthedocs.io",
	"readthedocs.org",
	"stackoverflow.com",
	"wikipedia.org",
	"ietf.org",
	"rfc-editor.org",
]);

/** Whether a fetch of `hostname` should be auto-allowed / eligible for raw passthrough. */
export function isPreapprovedHost(hostname: string, _pathname?: string): boolean {
	const host = hostname.toLowerCase().replace(/^www\./, "");
	if (PREAPPROVED_HOSTS.has(host)) return true;
	for (const approved of PREAPPROVED_HOSTS) {
		if (host === approved || host.endsWith(`.${approved}`)) return true;
	}
	return false;
}
