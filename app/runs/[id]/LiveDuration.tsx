"use client";

import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format";

export function LiveDuration({
  fixedDurationS,
  activeStartedAtMs,
}: {
  fixedDurationS?: number;
  activeStartedAtMs?: number;
}) {
  const [activeElapsedS, setActiveElapsedS] = useState(0);

  useEffect(() => {
    if (activeStartedAtMs === undefined) return;

    const update = () => {
      setActiveElapsedS(Math.max(0, (Date.now() - activeStartedAtMs) / 1000));
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [activeStartedAtMs]);

  if (fixedDurationS === undefined && activeStartedAtMs === undefined) return <>—</>;

  return (
    <span data-active-started-at-ms={activeStartedAtMs}>
      {formatDuration(
        (fixedDurationS ?? 0) + (activeStartedAtMs === undefined ? 0 : activeElapsedS),
      )}
    </span>
  );
}
