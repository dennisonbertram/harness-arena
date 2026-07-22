"use client";

import { useState } from "react";

export function CopyPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      style={{
        fontSize: 12,
        fontWeight: 500,
        padding: "6px 10px",
        borderRadius: 6,
        border: "1px solid var(--gray-alpha-400)",
        background: "var(--background-100)",
        color: "var(--gray-1000)",
        cursor: "pointer",
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
