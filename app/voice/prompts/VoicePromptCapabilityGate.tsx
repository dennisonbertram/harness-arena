"use client";

import { type ReactNode, useEffect, useState } from "react";

export default function VoicePromptCapabilityGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"pending" | "ready" | "failed">("pending");

  useEffect(() => {
    let active = true;
    fetch("/api/voice/capability", { method: "POST", credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error("capability bootstrap failed");
        if (active) setState("ready");
      })
      .catch(() => { if (active) setState("failed"); });
    return () => { active = false; };
  }, []);

  if (state === "ready") return children;
  if (state === "failed") return <p role="alert">Could not authorize audio. Reload to try again.</p>;
  return <p aria-live="polite">Authorizing audio…</p>;
}
