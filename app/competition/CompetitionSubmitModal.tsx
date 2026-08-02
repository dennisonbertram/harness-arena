"use client";

import { useRef, type ReactNode } from "react";

export function CompetitionSubmitModal({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function openDialog() {
    dialogRef.current?.showModal();
  }

  function returnFocusToTrigger() {
    triggerRef.current?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-controls="competition-submit-modal"
        onClick={openDialog}
        style={{
          height: 40,
          padding: "0 20px",
          borderRadius: 6,
          border: "none",
          background: "var(--gray-1000)",
          color: "var(--background-100)",
          fontWeight: 500,
          cursor: "pointer",
        }}
      >
        Submit a prompt
      </button>

      <dialog
        ref={dialogRef}
        id="competition-submit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="competition-submit-modal-heading"
        onClose={returnFocusToTrigger}
        style={{
          width: "min(640px, calc(100% - 32px))",
          maxHeight: "calc(100vh - 32px)",
          // globals.css has `* { margin: 0 }`, which overrides the UA
          // stylesheet's `margin: auto` on dialog and pins the modal to the
          // top-left corner. Restore centering explicitly.
          margin: "auto",
          overflowY: "auto",
          padding: 0,
          border: "1px solid var(--gray-alpha-400)",
          borderRadius: 12,
          background: "var(--background-100)",
          color: "var(--gray-1000)",
        }}
      >
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 20 }}>
            <h2 id="competition-submit-modal-heading" className="label">
              Submit a prompt
            </h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close submission dialog"
              style={{
                width: 32,
                height: 32,
                borderRadius: 6,
                border: "1px solid var(--gray-alpha-400)",
                background: "transparent",
                color: "var(--gray-1000)",
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
          {children}
        </div>
      </dialog>
    </>
  );
}
