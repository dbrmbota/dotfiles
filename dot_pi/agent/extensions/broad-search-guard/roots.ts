// Broad filesystem roots: directories a recursive walk should never start from.
// Matching is lexical and exact per path segment. A broad root does not match
// its descendants, so /opt/homebrew is broad but /opt/homebrew/Cellar/x is not.

import path from "node:path";

/** Broad on every OS. `/tmp` and `/private/tmp` are deliberately absent. */
const COMMON_ROOTS = [
	"/",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/etc",
	"/usr",
	"/usr/lib",
	"/usr/share",
	"/var",
	"/var/lib",
	"/opt",
	"/srv",
	"/root",
	"/boot",
	"/dev",
	"/proc",
	"/sys",
	"/run",
];

/** Broad on macOS. `~` is expanded to the home directory. `*` matches exactly one path segment. */
const MACOS_ROOTS = [
	"/Users",
	"/Users/*",
	"/System",
	"/System/Volumes/Data",
	"/Library",
	"/Applications",
	"/Network",
	"/private",
	"/private/var",
	"/private/etc",
	"/Volumes",
	"/Volumes/*",
	"/opt/homebrew",
	"~/Library",
	"~/Library/CloudStorage",
	"~/Library/CloudStorage/*",
	"~/Library/Mobile Documents",
	"~/Library/Mobile Documents/*",
];

/** Broad on Linux. */
const LINUX_ROOTS = [
	"/home",
	"/home/*",
	"/var/home",
	"/var/home/*",
	"/home/linuxbrew/.linuxbrew",
	"/nix",
	"/nix/store",
	"/snap",
	"/mnt",
	"/mnt/*",
	"/media",
	"/media/*",
	"/media/*/*",
	"/run/media",
	"/run/media/*",
	"/run/media/*/*",
	"/run/user/*",
	"/run/user/*/gvfs",
	"/run/user/*/gvfs/*",
	"/net",
];

/**
 * Returns a matcher for absolute, normalized paths. The matcher returns the
 * broad-root pattern that matches the path, or undefined when none does.
 * `home` and each of its ancestors are always broad, whatever the home path is.
 */
export function buildBroadRoots(home: string): (path: string) => string | undefined {
	const homeDir = path.posix.resolve(home);
	const ancestors: string[] = [];
	for (let dir = homeDir; ; dir = path.posix.dirname(dir)) {
		ancestors.push(dir);
		if (dir === "/") break;
	}
	const patterns = [...COMMON_ROOTS, ...MACOS_ROOTS, ...LINUX_ROOTS]
		.map((pattern) => (pattern.startsWith("~") ? homeDir + pattern.slice(1) : pattern))
		.concat(ancestors);
	const compiled = patterns.map((pattern) => ({
		pattern,
		segments: pattern.split("/").filter((segment) => segment !== ""),
	}));
	return (target) => {
		const segments = target.split("/").filter((segment) => segment !== "");
		const match = compiled.find(
			({ segments: patternSegments }) =>
				patternSegments.length === segments.length &&
				patternSegments.every((segment, index) => segment === "*" || segment === segments[index]),
		);
		return match?.pattern;
	};
}
