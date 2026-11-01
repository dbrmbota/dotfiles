/**
 * tuicr — parses the stderr protocol that tuicr 0.28 prints on exit.
 *
 * tuicr prints `tuicr-session: <slug>` and `tuicr-summary: reviewed N/M files, K comments added`
 * on stderr. `/review` reads the slug from the first line, and closes a round with no comments
 * when the summary shows every file reviewed and no comments. This module never imports pi
 * packages, so it can be unit-tested with `node --test`.
 */

/** Counts from the `tuicr-summary` line that tuicr prints on exit. */
export interface TuicrSummary {
	/** Files marked reviewed. */
	reviewed: number;
	/** Files in the review. */
	total: number;
	/** Comments added during the session. */
	comments: number;
}

/**
 * Parses the `tuicr-summary` line from tuicr's stderr.
 * Returns undefined when no line matches the tuicr 0.28 format.
 */
export function parseSummary(stderr: string): TuicrSummary | undefined {
	const match = /^tuicr-summary: reviewed (\d+)\/(\d+) files, (\d+) comments? added\r?$/m.exec(stderr);
	if (match === null) {
		return undefined;
	}
	return { reviewed: Number(match[1]), total: Number(match[2]), comments: Number(match[3]) };
}

/**
 * Returns true when the summary shows a round that closes without comments: at least one file,
 * every file reviewed, and no comments. An undefined summary is never clean.
 */
export function isReviewedClean(summary: TuicrSummary | undefined): boolean {
	return summary !== undefined && summary.total > 0 && summary.reviewed === summary.total && summary.comments === 0;
}

/** Parses the session slug from `tuicr-session: <slug>` on stderr. Returns undefined when no such line exists. */
export function parseSlug(stderr: string): string | undefined {
	return /^tuicr-session: (.+)$/m.exec(stderr)?.[1]?.trim();
}

/** Returns true for stderr lines that carry tuicr protocol data (`tuicr-session:` or `tuicr-summary:`). */
export function isMarkerLine(line: string): boolean {
	return line.startsWith("tuicr-session:") || line.startsWith("tuicr-summary:");
}
