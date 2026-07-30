"use client";

import { useEffect, useState } from "react";

// This client component is also server-rendered. A viewer-local
// `toLocaleTimeString()` produces different text in Vercel's UTC renderer and
// the browser, causing one React hydration error per event row. Pin both
// formatters to UTC so the initial HTML is identical on both sides.
const eventTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const eventDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export interface TimelineEvent {
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
}

export function EventTimeline({ events }: { events: TimelineEvent[] }) {
  const [selected, setSelected] = useState<TimelineEvent | null>(null);

  return (
    <>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }} className="mono">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
              <th style={{ ...cell, width: 40 }} className="label">#</th>
              <th style={{ ...cell, width: 110 }} className="label">Time</th>
              <th style={{ ...cell, width: 200 }} className="label">Event</th>
              <th style={cell} className="label">Payload</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.seq} style={{ borderBottom: "1px solid var(--gray-alpha-400)" }}>
                <td style={{ ...cell, color: "var(--gray-700)" }}>{event.seq}</td>
                <td style={{ ...cell, whiteSpace: "nowrap" }}>{eventTimeFormatter.format(new Date(event.ts))}</td>
                <td style={{ ...cell, color: "var(--gray-1000)", whiteSpace: "nowrap" }}>{event.type}</td>
                <td style={{ ...cell, maxWidth: 0 }}>
                  <button
                    type="button"
                    onClick={() => setSelected(event)}
                    title="Click to view formatted JSON"
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      font: "inherit",
                      color: "var(--blue-700)",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {JSON.stringify(event.payload)}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && <JsonModal event={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function JsonModal({ event, onClose }: { event: TimelineEvent; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Event ${event.seq} payload`}
      onClick={onClose}
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
          background: "var(--background-100, #111)",
          border: "1px solid var(--gray-alpha-400)",
          borderRadius: 12,
          maxWidth: 720,
          width: "100%",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "14px 18px",
            borderBottom: "1px solid var(--gray-alpha-400)",
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }} className="mono">
              {event.type}
            </div>
            <div style={{ fontSize: 12, color: "var(--gray-700)" }}>
              #{event.seq} · {eventDateTimeFormatter.format(new Date(event.ts))}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              font: "inherit",
              fontSize: 18,
              lineHeight: 1,
              color: "var(--gray-900)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: 18,
            fontSize: 13,
            lineHeight: 1.5,
            overflow: "auto",
            whiteSpace: "pre",
          }}
        >
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

const cell: React.CSSProperties = { padding: "8px 12px", textAlign: "left", verticalAlign: "top" };
