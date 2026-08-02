"use client";

import { useMemo, useState } from "react";
import { modelLabel } from "@/lib/models";
import type { Competition } from "@/lib/types";

type CompetitionFilterKey = "arena" | "harness" | "model" | "provider" | "status";
type CompetitionSelection = Record<CompetitionFilterKey, string>;

const fields: Array<{ key: CompetitionFilterKey; label: string }> = [
  { key: "arena", label: "Arena" },
  { key: "harness", label: "Harness" },
  { key: "model", label: "Model" },
  { key: "provider", label: "Provider" },
  { key: "status", label: "Status" },
];

function competitionFilterValue(competition: Competition, key: CompetitionFilterKey): string {
  if (key === "provider") return competition.gateway_provider ?? "__not-recorded__";
  return competition[key];
}

function selectionFor(competition: Competition): CompetitionSelection {
  return Object.fromEntries(fields.map(({ key }) => [key, competitionFilterValue(competition, key)])) as CompetitionSelection;
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayFilterValue(value: string, key: CompetitionFilterKey): string {
  if (key === "provider" && value === "__not-recorded__") return "Not recorded";
  return key === "model" ? modelLabel(value) : titleCase(value);
}

function uniqueFilterValues(competitions: Competition[], key: CompetitionFilterKey): string[] {
  return Array.from(new Set(competitions.map((competition) => competitionFilterValue(competition, key)))).sort();
}

export function CompetitionBrowser({
  competitions,
  selectedCompetition,
}: {
  competitions: Competition[];
  selectedCompetition: Competition | undefined;
}) {
  const [selection, setSelection] = useState<CompetitionSelection | null>(
    selectedCompetition ? selectionFor(selectedCompetition) : null,
  );

  const hasCompetition = useMemo(
    () =>
      selection !== null &&
      competitions.some((candidate) => fields.every(({ key }) => competitionFilterValue(candidate, key) === selection[key])),
    [competitions, selection],
  );

  if (!selectedCompetition || !selection) return null;

  return (
    <section aria-labelledby="competition-browser-heading" style={{ marginTop: 24 }}>
      <div
        style={{
          padding: "18px 20px",
          border: "1px solid var(--gray-alpha-400)",
          borderRadius: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <h2 id="competition-browser-heading" className="label" style={{ marginBottom: 6 }}>Browse competitions</h2>
            <p style={{ fontSize: 13, color: "var(--gray-700)" }}>Switch by the parameters that define the run.</p>
          </div>
        </div>
        <form action="/" method="get" role="search" style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
          {fields.map(({ key, label }) => {
            const id = `competition-${key}`;
            return (
              <label key={key} htmlFor={id} style={{ display: "grid", gap: 6, flex: "1 1 150px" }}>
                <span className="label">{label}</span>
                <select
                  id={id}
                  name={key}
                  value={selection[key]}
                  onChange={(event) => setSelection((current) => ({ ...current!, [key]: event.target.value }))}
                  style={{
                    width: "100%",
                    height: 40,
                    padding: "0 32px 0 10px",
                    border: "1px solid var(--gray-alpha-400)",
                    borderRadius: 6,
                    background: "var(--background-100)",
                    color: "var(--gray-1000)",
                    fontFamily: "var(--font-geist-mono)",
                    fontSize: 13,
                  }}
                >
                  {uniqueFilterValues(competitions, key).map((value) => (
                    <option key={value} value={value}>
                      {displayFilterValue(value, key)}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          <button
            type="submit"
            disabled={!hasCompetition}
            style={{
              height: 40,
              padding: "0 16px",
              border: "none",
              borderRadius: 6,
              background: hasCompetition ? "var(--gray-1000)" : "var(--gray-alpha-200)",
              color: hasCompetition ? "var(--background-100)" : "var(--gray-700)",
              fontWeight: 500,
              cursor: hasCompetition ? "pointer" : "not-allowed",
            }}
          >
            {hasCompetition ? "View competition" : "No competition"}
          </button>
        </form>
        {!hasCompetition && (
          <p role="status" style={{ margin: "10px 0 0", color: "var(--gray-700)", fontSize: 12 }}>
            No competition matches these parameters.
          </p>
        )}
      </div>
    </section>
  );
}
