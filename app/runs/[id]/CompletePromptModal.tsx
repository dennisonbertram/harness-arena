"use client";

import { useEffect, useState } from "react";

// Shows the COMPLETE system prompt the model receives — not just the submitted
// text. Verified against pi's buildSystemPrompt source (custom-prompt branch):
// with a submitted `--system-prompt`, pi's assembled prompt is the submitted
// text + appended context files + skills + a working-directory line. All 16
// task containers are bare (no AGENTS.md/CLAUDE.md, no skills — verified), so
// the only addition is the cwd line. A baseline run passes no --system-prompt
// at all, so pi uses its own built-in default instead of the submitted text.
// The caller reconstructs the right one of those two and passes it as `prompt`.
export function CompletePromptModal({ prompt, isBaseline }: { prompt: string; isBaseline: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          height: 28,
          padding: "0 10px",
          borderRadius: 6,
          border: "1px solid var(--gray-alpha-400)",
          background: "transparent",
          color: "var(--gray-1000)",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        View complete system prompt
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Complete system prompt"
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--background-100)",
              border: "1px solid var(--gray-alpha-400)",
              borderRadius: 12,
              maxWidth: 820,
              width: "100%",
              maxHeight: "85vh",
              display: "flex",
              flexDirection: "column",
              padding: 20,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ fontSize: 16, fontWeight: 600 }}>Complete system prompt</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  border: "none",
                  background: "transparent",
                  color: "var(--gray-900)",
                  fontSize: 18,
                  cursor: "pointer",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <p style={{ fontSize: 12, color: "var(--gray-700)", marginBottom: 12 }}>
              Exactly what the model receives as its system prompt:{" "}
              {isBaseline
                ? "no custom prompt was submitted, so this is pi's own built-in default plus its working-directory line."
                : "the submitted text plus pi's working-directory line."}{" "}
              Nothing else is added — the task containers carry no context files or skills. The read / bash / edit /
              write tools are supplied separately as tool definitions, and each task&apos;s instruction is sent as the
              first user message. This system prompt is identical for every task in the run.
            </p>
            <pre
              className="mono"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 13,
                padding: 16,
                borderRadius: 8,
                border: "1px solid var(--gray-alpha-400)",
                background: "var(--background-200)",
                overflow: "auto",
                margin: 0,
              }}
            >
              {prompt}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}
