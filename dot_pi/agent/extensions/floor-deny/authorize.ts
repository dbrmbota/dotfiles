/**
 * Pure decision logic for the `floor-deny` authorizer link. It has no Pi runtime
 * imports, so it runs under `node --test` on its own.
 */

/** The name the link is registered under. `authorizerChain` references it. */
export const LINK_NAME = "floor-deny";

/**
 * The `eval` commands the link may approve. Matching is exact on the trimmed
 * command text, so any suffix or extra argument falls through to the ask.
 */
export const ALLOWED_EVAL_COMMANDS: ReadonlySet<string> = new Set([
	'eval "$(direnv export bash)"',
	'eval "$(ssh-agent -s)"',
	'eval "$(mise activate bash)"',
	'eval "$(starship init bash)"',
]);

const BASH_SURFACE = "bash";
const PARSE_FLOOR_SENTINELS: ReadonlySet<string> = new Set([
	"<unparseable-bash-command>",
	"<unparsed-bash-subtree>",
]);
const OPAQUE_WRAPPER_FLOOR = "<opaque-bash-wrapper>";
const HEREDOC_PATTERN = /(?<!<)<<(?!<)/;
const HEREDOC_DENY_REASON =
	"This bash command could not be parsed, and it contains a heredoc. Rewrite it so the shell can parse it: " +
	"use `|&` instead of `2>&1 |`; group the command as `{ cmd <<'EOF' ...; } 2>&1 | ...` or " +
	"`( cmd <<'EOF' ... ) 2>&1 | ...`; or write the input to a temp file and redirect it with `< file`.";

/** One unit of a bash chain that the gate left asking, as the link reads it. */
export interface AskingBashUnitLike {
	readonly command: string;
	readonly floor?: string;
	readonly matchedPattern?: string | null;
}

/**
 * The fields of an ask's details that the link reads. A structural subset of
 * `PromptPermissionDetails` from `@gotgenes/pi-permission-system`.
 */
export interface AskDetailsLike {
	readonly command?: string;
	readonly accessIntent?: {
		readonly surface?: string;
		readonly floor?: string;
		readonly matchValues?: readonly string[];
		readonly askingUnits?: readonly AskingBashUnitLike[];
	};
	readonly payload?: {
		readonly request?: {
			readonly surface?: string;
			readonly value?: string;
			readonly matchedPattern?: string | null;
		};
	};
}

/**
 * A link's ruling on an `ask`. Mirrors the `Authorizer` verdict of
 * `@gotgenes/pi-permission-system`. `allow_units` names the bash units to allow.
 */
export type AuthorizerVerdict =
	| { readonly kind: "allow" }
	| { readonly kind: "deny"; readonly reason?: string }
	| { readonly kind: "defer" }
	| { readonly kind: "allow_units"; readonly units: readonly string[] };

/** The link's ruling. An alias of {@link AuthorizerVerdict}. */
export type FloorDecision = AuthorizerVerdict;

/** The part of the permission review log that a link writes to. */
export interface AuthorizerLogLike {
	review(event: string, details?: Record<string, unknown>): void;
}

/**
 * Decide an `ask` for the `floor-deny` link. This function is pure and does no I/O.
 *
 * Non-bash asks defer. A parse-floor ask (`<unparseable-bash-command>` or
 * `<unparsed-bash-subtree>`) that contains a heredoc is denied with rewrite
 * guidance. An ask whose opaque-wrapper units are allowlisted `eval` commands is
 * allowed, or narrowed to those units with `allow_units`. Everything else defers.
 *
 * @param details - The ask's details, as passed to a registered authorizer.
 * @param allowedEvalCommands - Exact trimmed `eval` commands to approve. Defaults to {@link ALLOWED_EVAL_COMMANDS}.
 * @returns The link's verdict for the ask.
 */
export function evaluateFloorAsk(
	details: AskDetailsLike,
	allowedEvalCommands: ReadonlySet<string> = ALLOWED_EVAL_COMMANDS,
): FloorDecision {
	if (!isBashAsk(details)) return { kind: "defer" };
	if (hasParseFloorSentinel(details) && containsHeredoc(commandText(details))) {
		return { kind: "deny", reason: HEREDOC_DENY_REASON };
	}
	const askingUnits = details.accessIntent?.askingUnits;
	if (askingUnits !== undefined) {
		const units = allowedEvalUnits(askingUnits, allowedEvalCommands);
		return units.length > 0 ? { kind: "allow_units", units } : { kind: "defer" };
	}
	const floorIsOpaqueWrapper =
		details.accessIntent?.floor === OPAQUE_WRAPPER_FLOOR ||
		details.payload?.request?.matchedPattern === OPAQUE_WRAPPER_FLOOR;
	if (floorIsOpaqueWrapper && allowedEvalCommands.has(commandText(details).trim())) {
		return { kind: "allow" };
	}
	return { kind: "defer" };
}

/**
 * Whether the ask was raised on the bash surface. Reads `accessIntent.surface`,
 * then falls back to `payload.request.surface`.
 */
function isBashAsk(details: AskDetailsLike): boolean {
	const surface = details.accessIntent?.surface ?? details.payload?.request?.surface;
	return surface === BASH_SURFACE;
}

/**
 * The command text of the ask. Reads `command`, then `payload.request.value`,
 * then `accessIntent.matchValues[0]`, and returns `""` when none is set. The
 * text is not trimmed.
 */
function commandText(details: AskDetailsLike): string {
	return (
		details.command ??
		details.payload?.request?.value ??
		details.accessIntent?.matchValues?.[0] ??
		""
	);
}

/**
 * Whether any floor sentinel of the ask is a parse-floor sentinel. Checks
 * `accessIntent.floor`, `payload.request.matchedPattern`, and each
 * `accessIntent.askingUnits[*]` `floor` and `matchedPattern`.
 */
function hasParseFloorSentinel(details: AskDetailsLike): boolean {
	const candidates: Array<string | null | undefined> = [
		details.accessIntent?.floor,
		details.payload?.request?.matchedPattern,
		...(details.accessIntent?.askingUnits ?? []).flatMap((unit) => [
			unit.floor,
			unit.matchedPattern,
		]),
	];
	return candidates.some(
		(candidate) => typeof candidate === "string" && PARSE_FLOOR_SENTINELS.has(candidate),
	);
}

/**
 * Whether the command contains a heredoc. A here-string (`<<<`) does not count.
 */
function containsHeredoc(command: string): boolean {
	return HEREDOC_PATTERN.test(command);
}

/**
 * The asking units floored by an opaque wrapper whose trimmed command is in
 * `allowedEvalCommands`, in input order, as command text.
 */
function allowedEvalUnits(
	units: readonly AskingBashUnitLike[],
	allowedEvalCommands: ReadonlySet<string>,
): string[] {
	return units
		.filter(
			(unit) =>
				unit.floor === OPAQUE_WRAPPER_FLOOR && allowedEvalCommands.has(unit.command.trim()),
		)
		.map((unit) => unit.command);
}
