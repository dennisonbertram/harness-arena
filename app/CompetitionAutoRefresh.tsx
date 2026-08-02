"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 15_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "reaped"]);

/**
 * Poll only the pending runs, then refresh the expensive server-rendered board
 * once one becomes terminal. ISR updates a later request but cannot update an
 * already-open tab by itself.
 */
export function CompetitionAutoRefresh({ runIds }: { runIds: string[] }) {
  const router = useRouter();

  useEffect(() => {
    if (runIds.length === 0) return;
    let cancelled = false;
    let pollInFlight = false;
    let refreshRequested = false;

    async function poll() {
      if (pollInFlight || refreshRequested || document.visibilityState === "hidden") return;
      pollInFlight = true;
      try {
        const statuses = await Promise.all(
          runIds.map(async (runId) => {
            try {
              const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
              if (!response.ok) return undefined;
              const body = (await response.json()) as { status?: string };
              return body.status;
            } catch {
              return undefined;
            }
          }),
        );
        if (!cancelled && statuses.some((status) => status !== undefined && TERMINAL_STATUSES.has(status))) {
          refreshRequested = true;
          router.refresh();
        }
      } finally {
        pollInFlight = false;
      }
    }

    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [runIds, router]);

  return null;
}
