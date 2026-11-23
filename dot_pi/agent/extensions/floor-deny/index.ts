/**
 * `floor-deny` extension. Registers the `floor-deny` authorizer link on this
 * node's permission service, so an `authorizerChain` entry can name it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AskDetailsLike,
	type AuthorizerLogLike,
	type AuthorizerVerdict,
	LINK_NAME,
	evaluateFloorAsk,
} from "./authorize.ts";

/** The part of the permission service that this link uses. */
export interface PermissionsServiceLike {
	registerAuthorizer(
		name: string,
		authorize: (
			details: AskDetailsLike,
			query: unknown,
			log: AuthorizerLogLike,
		) => Promise<AuthorizerVerdict>,
	): () => void;
}

/** The part of the Pi host that this extension uses. */
export interface FloorDenyHost {
	on(event: "session_shutdown", handler: () => void): unknown;
	events: {
		on(channel: string, handler: (data: unknown) => void): () => void;
	};
}

/**
 * Injectable seams for {@link registerFloorDeny}. The defaults read the
 * process-global service map and write warnings to `console.warn`.
 */
export interface FloorDenyDeps {
	/** Return the permission service published for `sessionId`, or `undefined`. */
	resolveService(sessionId: string): PermissionsServiceLike | undefined;
	/** Report a setup problem that does not stop the extension. */
	warn(message: string): void;
}

const PERMISSIONS_READY_CHANNEL = "permissions:ready";
const SESSION_SERVICES_KEY = Symbol.for(
	"@gotgenes/pi-permission-system:session-services",
);
const DEFAULT_DEPS: FloorDenyDeps = {
	resolveService: resolveServiceFromGlobal,
	warn: (message) => console.warn(message),
};

/**
 * Register the `floor-deny` link on the permission service of each session that
 * publishes one. Registration runs on `permissions:ready`, is idempotent, and is
 * undone on `session_shutdown`. The `permissions:ready` subscription stays
 * active, so a later session in the same process registers again. A missing
 * service, a rejected registration, or an error during evaluation fails safe:
 * the ask goes on to the normal prompt.
 *
 * @param pi - The Pi host, for its `on` hook and shared `events` bus.
 * @param deps - Overrides for the service lookup and the warning sink. Omitted keys use the defaults.
 */
export function registerFloorDeny(
	pi: FloorDenyHost,
	deps: Partial<FloorDenyDeps> = {},
): void {
	const { resolveService, warn } = { ...DEFAULT_DEPS, ...deps };
	let unregisterLink: (() => void) | undefined;
	let warnedMissingService = false;

	pi.events.on(PERMISSIONS_READY_CHANNEL, (data) => {
		const sessionId = sessionIdOf(data);
		const service = sessionId === null ? undefined : resolveService(sessionId);
		if (service === undefined) {
			if (!warnedMissingService) {
				warnedMissingService = true;
				warn(
					`floor-deny: no permission service published for session ${sessionId ?? "(none)"}; the link is not registered.`,
				);
			}
			return;
		}
		if (unregisterLink !== undefined) return;
		try {
			unregisterLink = service.registerAuthorizer(LINK_NAME, (details, _query, log) =>
				authorizeAsk(details, log),
			);
		} catch (error) {
			warn(
				`floor-deny: could not register the link: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});

	pi.on("session_shutdown", () => {
		unregisterLink?.();
		unregisterLink = undefined;
		warnedMissingService = false;
	});
}

/**
 * Pi's extension entry point. It calls {@link registerFloorDeny} with the
 * default dependencies.
 */
export default function floorDenyExtension(pi: ExtensionAPI): void {
	registerFloorDeny(pi);
}

/**
 * Read the service that the process-global service map holds for `sessionId`.
 * Returns `undefined` when the map or the entry is absent. Does not import
 * `@gotgenes/pi-permission-system`, because Pi isolates npm package roots.
 */
function resolveServiceFromGlobal(sessionId: string): PermissionsServiceLike | undefined {
	const services: unknown = Reflect.get(globalThis, SESSION_SERVICES_KEY);
	if (!(services instanceof Map)) return undefined;
	const service: unknown = services.get(sessionId);
	return isPermissionsService(service) ? service : undefined;
}

/**
 * Whether `value` has the `registerAuthorizer` method of a permission service.
 * Narrows an unknown map entry without a cast.
 */
function isPermissionsService(value: unknown): value is PermissionsServiceLike {
	return (
		typeof value === "object" &&
		value !== null &&
		"registerAuthorizer" in value &&
		typeof value.registerAuthorizer === "function"
	);
}

/**
 * The `sessionId` from a `permissions:ready` payload. Returns `null` when the
 * payload is not an object or its `sessionId` is not a string.
 */
function sessionIdOf(data: unknown): string | null {
	if (typeof data !== "object" || data === null) return null;
	const sessionId: unknown = Reflect.get(data, "sessionId");
	return typeof sessionId === "string" ? sessionId : null;
}

/**
 * Evaluate an ask for the link and record a non-defer verdict in the review log.
 * Any error becomes `{ kind: "defer" }`, so a bug fails safe to the normal prompt.
 */
async function authorizeAsk(
	details: AskDetailsLike,
	log: AuthorizerLogLike,
): Promise<AuthorizerVerdict> {
	try {
		const verdict = evaluateFloorAsk(details);
		if (verdict.kind !== "defer") {
			log.review(LINK_NAME, {
				verdict: verdict.kind,
				reason: verdict.kind === "deny" ? verdict.reason : undefined,
				units: verdict.kind === "allow_units" ? verdict.units : undefined,
			});
		}
		return verdict;
	} catch {
		return { kind: "defer" };
	}
}
