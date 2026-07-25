"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Re-fetches the server-rendered pending list every 15s so progress updates
// without a manual reload. Only mounted when runs are in flight.
export function PendingAutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 15000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}
