import type { Run } from "@/lib/types";

const ACTIVE_STATUSES: ReadonlySet<Run["status"]> = new Set(["running", "queued"]);

/** Whether a run's detail page should keep polling for updates via router.refresh(). */
export function shouldPollRunStatus(status: Run["status"]): boolean {
  return ACTIVE_STATUSES.has(status);
}

export interface RunStatusBadgeStyle {
  bg: string;
  fg: string;
}

/**
 * Badge colors per run status. `completed` uses blue-800 text on blue-100
 * background (~5.34:1 contrast) rather than blue-700 (~4.28:1), which falls
 * short of WCAG AA's 4.5:1 minimum for normal-size text.
 */
export const RUN_STATUS_BADGE_STYLES: Record<Run["status"], RunStatusBadgeStyle> = {
  completed: { bg: "var(--blue-100)", fg: "var(--blue-800)" },
  running: { bg: "var(--gray-100)", fg: "var(--gray-900)" },
  queued: { bg: "var(--gray-100)", fg: "var(--gray-900)" },
  failed: { bg: "var(--red-100)", fg: "var(--red-700)" },
  reaped: { bg: "var(--gray-100)", fg: "var(--gray-900)" },
};
