"use client";

import { useState } from "react";
import type { BaselineState, CompetitionRow } from "@/lib/competition-leaderboard";
import { modelColor, modelLabel } from "@/lib/models";
import { ScatterChart, type ScatterItem } from "./ScatterChart";
import { CompetitionLeaderboardTable } from "./competition/CompetitionLeaderboardTable";

interface ScatterScale {
  width: number;
  height: number;
  padding: number;
  xMax: number;
  yMax: number;
}

interface Props {
  scatterItems: ScatterItem[];
  scatterScale: ScatterScale;
  chartModel: string;
  ranked: CompetitionRow[];
  belowBaseline: CompetitionRow[];
  baselineRow: CompetitionRow | null;
  baselineModel: string;
  baselineState: BaselineState;
  baselineRejectionReason?: string;
  currentGithubLogin: string | undefined;
}

/** Keeps the visual comparison between one chart point and one leaderboard row in sync. */
export function CompetitionLeaderboardWithChart({
  scatterItems,
  scatterScale,
  chartModel,
  ranked,
  belowBaseline,
  baselineRow,
  baselineModel,
  baselineState,
  baselineRejectionReason,
  currentGithubLogin,
}: Props) {
  const [hoveredRunId, setHoveredRunId] = useState<string | null>(null);
  const isEmpty = ranked.length === 0 && belowBaseline.length === 0 && !baselineRow && baselineState === "none";

  return (
    <>
      {scatterItems.length > 0 ? (
        <section style={{ marginTop: 32, overflowX: "auto" }}>
          <h2 className="label" style={{ marginBottom: 8 }}>
            Cost vs. tasks passed <span style={{ color: "var(--gray-700)" }}>· one dot per scored run</span>
          </h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 12, fontSize: 12 }}>
            <span>
              <span style={{ color: modelColor(chartModel), marginRight: 5 }}>●</span>
              {modelLabel(chartModel)}
            </span>
            {baselineRow ? <span style={{ color: "var(--gray-700)" }}>◌ dashed = baseline (vanilla prompt)</span> : null}
          </div>
          <ScatterChart
            items={scatterItems}
            width={scatterScale.width}
            height={scatterScale.height}
            padding={scatterScale.padding}
            xMax={scatterScale.xMax}
            yMax={scatterScale.yMax}
            hoveredRunId={hoveredRunId}
            onHoveredRunIdChange={setHoveredRunId}
          />
        </section>
      ) : null}

      <section style={{ marginTop: 40, overflowX: "auto" }}>
        <h2 className="label" style={{ marginBottom: 16 }}>
          Leaderboard <span style={{ color: "var(--gray-700)" }}>· ranked by tasks solved, then cost</span>
        </h2>
        {isEmpty ? (
          <div
            style={{
              border: "1px solid var(--gray-alpha-400)",
              borderRadius: 12,
              padding: 32,
              textAlign: "center",
              color: "var(--gray-900)",
            }}
          >
            No entries yet — beat the baseline.
          </div>
        ) : (
          <CompetitionLeaderboardTable
            ranked={ranked}
            belowBaseline={belowBaseline}
            currentGithubLogin={currentGithubLogin}
            baselineRow={baselineRow}
            baselineModel={baselineModel}
            baselineState={baselineState}
            baselineRejectionReason={baselineRejectionReason}
            hoveredRunId={hoveredRunId}
            onHoveredRunIdChange={setHoveredRunId}
          />
        )}
      </section>
    </>
  );
}
