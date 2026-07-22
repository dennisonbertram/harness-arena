import type { Run } from "@/lib/types";

/** Whether a run's detail page should keep polling for updates via router.refresh(). */
export function shouldPollRunStatus(status: Run["status"]): boolean {
  // TODO(TASK-8-review): stub — not yet wired to the active (running/queued) statuses.
  return false;
}

export interface RunStatusBadgeStyle {
  bg: string;
  fg: string;
}

export const RUN_STATUS_BADGE_STYLES: Record<Run["status"], RunStatusBadgeStyle> = {
  completed: { bg: "var(--blue-100)", fg: "var(--blue-700)" },
  running: { bg: "var(--gray-100)", fg: "var(--gray-900)" },
  queued: { bg: "var(--gray-100)", fg: "var(--gray-900)" },
  failed: { bg: "var(--red-100)", fg: "var(--red-700)" },
  reaped: { bg: "var(--gray-100)", fg: "var(--gray-900)" },
};
