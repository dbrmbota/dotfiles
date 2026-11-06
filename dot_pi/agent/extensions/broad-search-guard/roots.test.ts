import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildBroadRoots } from "./roots.ts";

function broadRoot(path: string, home = "/Users/u"): string | undefined {
	return buildBroadRoots(home)(path);
}

describe("buildBroadRoots", () => {
	it("matches an exact broad root and returns its pattern", () => {
		assert.equal(broadRoot("/"), "/");
		assert.equal(broadRoot("/Users"), "/Users");
		assert.equal(broadRoot("/opt/homebrew"), "/opt/homebrew");
		assert.equal(broadRoot("/Volumes"), "/Volumes");
	});

	it("does not match descendants of a broad root", () => {
		assert.equal(broadRoot("/opt/homebrew/Cellar/pi-coding-agent"), undefined);
		assert.equal(broadRoot("/usr/local/include"), undefined);
		assert.equal(broadRoot("/Volumes/NAS/x"), undefined);
	});

	it("matches * against exactly one path segment", () => {
		assert.equal(broadRoot("/Volumes/NAS"), "/Volumes/*");
		assert.equal(broadRoot("/media/u/disk"), "/media/*/*");
		assert.equal(broadRoot("/media/u"), "/media/*");
		assert.equal(broadRoot("/media/u/disk/deeper"), undefined);
	});

	it("treats home and each of its ancestors as broad for a custom home", () => {
		assert.equal(broadRoot("/data/users/u", "/data/users/u"), "/data/users/u");
		assert.equal(broadRoot("/data/users", "/data/users/u"), "/data/users");
		assert.equal(broadRoot("/data", "/data/users/u"), "/data");
		assert.equal(broadRoot("/data/users/u/proj", "/data/users/u"), undefined);
	});

	it("expands ~ to the home directory", () => {
		assert.equal(broadRoot("/Users/u/Library"), "/Users/u/Library");
		assert.equal(broadRoot("/Users/u/proj"), undefined);
	});

	it("matches cloud-storage and mobile-document roots under home", () => {
		assert.equal(
			broadRoot("/Users/u/Library/CloudStorage/OneDrive-X"),
			"/Users/u/Library/CloudStorage/*",
		);
		assert.equal(
			broadRoot("/Users/u/Library/Mobile Documents/com~apple~CloudDocs"),
			"/Users/u/Library/Mobile Documents/*",
		);
	});

	it("matches macOS system and mount roots", () => {
		assert.equal(broadRoot("/System/Volumes/Data"), "/System/Volumes/Data");
		assert.equal(broadRoot("/private/var"), "/private/var");
	});

	it("matches Linux roots", () => {
		assert.equal(broadRoot("/home/u"), "/home/*");
		assert.equal(broadRoot("/mnt/c"), "/mnt/*");
		assert.equal(broadRoot("/proc"), "/proc");
		assert.equal(broadRoot("/nix/store"), "/nix/store");
		assert.equal(
			broadRoot("/run/user/1000/gvfs/smb-share:x"),
			"/run/user/*/gvfs/*",
		);
	});

	it("does not match /tmp or /private/tmp", () => {
		assert.equal(broadRoot("/tmp"), undefined);
		assert.equal(broadRoot("/private/tmp"), undefined);
	});
});
