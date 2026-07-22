"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Run } from "@/lib/types";
import { shouldPollRunStatus } from "@/lib/run-status";

const POLL_INTERVAL_MS = 15_000;

/**
 * ISR (`revalidate = 15`) only refreshes the run page for a *new* request —
 * it does nothing for a browser tab left open on the page. This component
 * polls the server (router.refresh() re-fetches the RSC payload) every 15s
 * while the run is still running/queued, and stops once it reaches a
 * terminal status.
 */
export function RunAutoRefresh({ status }: { status: Run["status"] }) {
  const router = useRouter();

  useEffect(() => {
    if (!shouldPollRunStatus(status)) return;
    const id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status, router]);

  return null;
}
