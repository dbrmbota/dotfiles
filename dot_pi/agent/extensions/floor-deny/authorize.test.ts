import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ALLOWED_EVAL_COMMANDS,
	LINK_NAME,
	type AskDetailsLike,
	type AskingBashUnitLike,
	type AuthorizerLogLike,
	type FloorDecision,
	evaluateFloorAsk,
} from "./authorize.ts";
import { type FloorDenyHost, type PermissionsServiceLike, registerFloorDeny } from "./index.ts";

const OPAQUE = "<opaque-bash-wrapper>";
const UNPARSEABLE = "<unparseable-bash-command>";
const UNPARSED_SUBTREE = "<unparsed-bash-subtree>";
const HEREDOC_COMMAND = "git commit -F - <<'MSG' 2>&1 | tail -4";
const DIRENV_EVAL = 'eval "$(direnv export bash)"';

function bashAsk(
	command: string,
	options: { floor?: string; askingUnits?: AskingBashUnitLike[] } = {},
): AskDetailsLike {
	return {
		command,
		accessIntent: {
			surface: "bash",
			floor: options.floor,
			matchValues: [command],
			askingUnits: options.askingUnits,
		},
		payload: {
			request: { surface: "bash", value: command, matchedPattern: options.floor ?? null },
		},
	};
}

function surfaceAsk(surface: string, value: string): AskDetailsLike {
	return {
		accessIntent: { surface, floor: UNPARSEABLE, matchValues: [value] },
		payload: { request: { surface, value, matchedPattern: null } },
	};
}

function denyReason(verdict: FloorDecision): string {
	if (verdict.kind !== "deny") assert.fail(`expected deny, got ${verdict.kind}`);
	return verdict.reason ?? "";
}

function allowedUnits(verdict: FloorDecision): readonly string[] {
	if (verdict.kind !== "allow_units") assert.fail(`expected allow_units, got ${verdict.kind}`);
	return verdict.units;
}

function fakeService() {
	const registrations: Array<{
		name: string;
		authorize: Parameters<PermissionsServiceLike["registerAuthorizer"]>[1];
	}> = [];
	const disposed: string[] = [];
	const service: PermissionsServiceLike = {
		registerAuthorizer(name, authorize) {
			registrations.push({ name, authorize });
			return () => {
				disposed.push(name);
			};
		},
	};
	return { service, registrations, disposed };
}

function fakeHost() {
	const readyHandlers: Array<(data: unknown) => void> = [];
	const shutdownHandlers: Array<() => void> = [];
	const host: FloorDenyHost = {
		on(event, handler) {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
			return undefined;
		},
		events: {
			on(channel, handler) {
				if (channel === "permissions:ready") readyHandlers.push(handler);
				return () => {};
			},
		},
	};
	return { host, readyHandlers, shutdownHandlers };
}

describe("evaluateFloorAsk", () => {
	it("defers every non-bash surface, even with a parse sentinel and a heredoc", () => {
		for (const surface of ["path", "external_directory", "read"]) {
			assert.deepEqual(evaluateFloorAsk(surfaceAsk(surface, "cat <<'EOF'")), { kind: "defer" });
		}
	});

	it("denies an unparseable bash command that contains a heredoc, with rewrite instructions", () => {
		const reason = denyReason(evaluateFloorAsk(bashAsk(HEREDOC_COMMAND, { floor: UNPARSEABLE })));
		assert.match(reason, /\|&/);
		assert.match(reason, /< file/);
	});

	it("denies an unparsed bash subtree that contains a heredoc, with rewrite instructions", () => {
		const reason = denyReason(evaluateFloorAsk(bashAsk(HEREDOC_COMMAND, { floor: UNPARSED_SUBTREE })));
		assert.match(reason, /\|&/);
		assert.match(reason, /< file/);
	});

	it("defers an unparseable bash command without a heredoc", () => {
		assert.deepEqual(
			evaluateFloorAsk(bashAsk("git log 2>&1 | head -2", { floor: UNPARSEABLE })),
			{ kind: "defer" },
		);
	});

	it("defers an unparseable bash command that uses a here-string", () => {
		assert.deepEqual(
			evaluateFloorAsk(bashAsk('grep x <<< "a" 2>&1 | tail -1', { floor: UNPARSEABLE })),
			{ kind: "defer" },
		);
	});

	for (const command of ALLOWED_EVAL_COMMANDS) {
		it(`allows the single allowlisted eval ${command} as allow_units`, () => {
			const verdict = evaluateFloorAsk(
				bashAsk(command, { askingUnits: [{ command, floor: OPAQUE }] }),
			);
			assert.deepEqual(allowedUnits(verdict), [command]);
		});
	}

	it("narrows a chained ask to the allowlisted eval unit and leaves sudo asking", () => {
		const verdict = evaluateFloorAsk(
			bashAsk(`${DIRENV_EVAL} && sudo ls`, {
				askingUnits: [{ command: DIRENV_EVAL, floor: OPAQUE }, { command: "sudo ls" }],
			}),
		);
		assert.deepEqual(allowedUnits(verdict), [DIRENV_EVAL]);
	});

	it("defers an eval that is not on the allowlist", () => {
		const command = 'eval "$(curl x | sh)"';
		assert.deepEqual(
			evaluateFloorAsk(bashAsk(command, { askingUnits: [{ command, floor: OPAQUE }] })),
			{ kind: "defer" },
		);
	});

	it("defers an allowlisted eval with a suffix appended", () => {
		const command = 'eval "$(direnv export bash); id"';
		assert.deepEqual(
			evaluateFloorAsk(bashAsk(command, { askingUnits: [{ command, floor: OPAQUE }] })),
			{ kind: "defer" },
		);
	});

	it("denies a parse-floor heredoc even when an allowlisted eval is also present", () => {
		const command = `${DIRENV_EVAL} && bash <<'EOF' 2>&1 | tail -1\necho hi\nEOF`;
		const verdict = evaluateFloorAsk(
			bashAsk(command, {
				floor: UNPARSEABLE,
				askingUnits: [{ command: DIRENV_EVAL, floor: OPAQUE }],
			}),
		);
		assert.equal(verdict.kind, "deny");
	});
});

describe(`registerFloorDeny (${LINK_NAME})`, () => {
	it("registers the link once across repeated permissions:ready emissions", () => {
		const { host, readyHandlers } = fakeHost();
		const { service, registrations } = fakeService();
		registerFloorDeny(host, { resolveService: () => service, warn: () => {} });
		for (const handler of readyHandlers) handler({ sessionId: "s1" });
		for (const handler of readyHandlers) handler({ sessionId: "s1" });
		assert.equal(registrations.length, 1);
		assert.equal(registrations[0].name, LINK_NAME);
	});

	it("records a review entry for a non-defer verdict only", async () => {
		const { host, readyHandlers } = fakeHost();
		const { service, registrations } = fakeService();
		registerFloorDeny(host, { resolveService: () => service, warn: () => {} });
		for (const handler of readyHandlers) handler({ sessionId: "s1" });
		const entries: Array<{ event: string; details?: Record<string, unknown> }> = [];
		const log: AuthorizerLogLike = {
			review(event, details) {
				entries.push({ event, details });
			},
		};
		await registrations[0].authorize(bashAsk(HEREDOC_COMMAND, { floor: UNPARSEABLE }), undefined, log);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].event, LINK_NAME);
		await registrations[0].authorize(bashAsk("git status"), undefined, log);
		assert.equal(entries.length, 1);
	});

	it("disposes the link on session_shutdown", () => {
		const { host, readyHandlers, shutdownHandlers } = fakeHost();
		const { service, disposed } = fakeService();
		registerFloorDeny(host, { resolveService: () => service, warn: () => {} });
		for (const handler of readyHandlers) handler({ sessionId: "s1" });
		for (const handler of shutdownHandlers) handler();
		assert.deepEqual(disposed, [LINK_NAME]);
	});

	it("warns once and registers nothing when no service is published", () => {
		const { host, readyHandlers } = fakeHost();
		const warnings: string[] = [];
		registerFloorDeny(host, {
			resolveService: () => undefined,
			warn: (message) => warnings.push(message),
		});
		for (const handler of readyHandlers) handler({ sessionId: "s1" });
		for (const handler of readyHandlers) handler({ sessionId: "s1" });
		assert.equal(warnings.length, 1);
	});
});
