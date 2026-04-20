/**
 * src/agent/lanes.ts — Per-session lane isolation for nested agent operations.
 *
 * Prevents cross-session blocking by scoping the nested lane to the target
 * session key. Previously, all nested operations across ALL sessions shared
 * one global "nested" lane with maxConcurrent=1, causing a long-running Worker
 * nested task to block nested operations across all other sessions.
 *
 * Architecture (after fix):
 *   session-A nested lane (nested:A)  <-- runs independently
 *   session-B nested lane (nested:B)  <-- runs independently
 *   session-C nested lane (nested:C)  <-- runs independently
 *   Legacy/cron paths fallback to unscoped "nested"
 */

const NESTED_LANE = 'nested';
const NESTED_LANE_PREFIX = `${NESTED_LANE}:`;

/**
 * Resolve the lane for a nested agent operation, scoped to the target session.
 *
 * - With a valid, non-empty session key that is NOT 'main'
 *   → returns `nested:<sessionKey>`
 *   Each session gets its own lane, enabling parallel execution.
 * - With 'main' session key (the primary orchestrator session)
 *   → returns bare `"nested"` since main is the root session and does not
 *   need per-session isolation for nested operations.
 * - Without a session key (null, undefined, empty string, whitespace-only)
 *   → returns bare `"nested"` for legacy/cron paths that don't have a target session.
 */
export function resolveNestedAgentLaneForSession(sessionKey: string | null | undefined): string {
  const trimmed = sessionKey?.trim();
  if (!trimmed || trimmed === 'main') {
    return NESTED_LANE;
  }
  return `${NESTED_LANE_PREFIX}${trimmed}`;
}

/**
 * Check whether a lane string is a nested agent lane.
 * Recognizes the unscoped `"nested"` and scoped `"nested:<anything>"` variants.
 *
 * Used for delivery logging, metrics, and routing decisions.
 */
export function isNestedAgentLane(lane: string | undefined): boolean {
  if (!lane) {
    return false;
  }
  return lane === NESTED_LANE || lane.startsWith(NESTED_LANE_PREFIX);
}