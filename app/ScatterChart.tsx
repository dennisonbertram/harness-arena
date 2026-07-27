"use client";

import { useState } from "react";
import { formatUsd } from "@/lib/format";
import { modelColor, modelLabel } from "@/lib/models";
import { UNKNOWN_GITHUB_LOGIN } from "@/lib/github";

export interface ScatterItem {
  runId: string;
  cx: number;
  cy: number;
  // The submitter's GitHub login -- ignored for a baseline item, which
  // labels by model instead (matches the leaderboard table's convention).
  githubLogin: string;
  model: string;
  tasksPassed: number;
  totalTasks: number;
  totalCostUsd: number;
  isBaseline: boolean;
}

interface Props {
  items: ScatterItem[];
  width: number;
  height: number;
  padding: number;
  xMax: number;
  yMax: number;
}

// Full-width cost-vs-tasks chart. Detail is revealed on hover (the dots
// cluster tightly, so static labels overlapped) via an SVG-native tooltip
// that scales with the chart.
export function ScatterChart({ items, width, height, padding, xMax, yMax }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const plotRight = width - padding;
  const plotTop = padding;
  const plotBottom = height - padding;
  const yStep = yMax > 10 ? 4 : 2;
  const yTicks = Array.from({ length: Math.floor(yMax / yStep) + 1 }, (_, i) => i * yStep);
  const xTicks = [0, 0.25, 0.5, 0.75, 1];
  const hoveredItem = items.find((i) => i.runId === hovered) ?? null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height + 26}`}
      width="100%"
      style={{ display: "block", color: "var(--gray-1000)" }}
      role="img"
      aria-label="Total inference cost versus tasks passed for each scored run (hover a point for detail)"
    >
      {/* Horizontal gridlines + Y ticks */}
      {yTicks.map((t) => {
        const y = plotBottom - (t / yMax) * (plotBottom - plotTop);
        return (
          <g key={`y${t}`}>
            <line x1={padding} y1={y} x2={plotRight} y2={y} stroke="var(--gray-alpha-300)" />
            <text x={padding - 8} y={y + 4} fontSize={12} textAnchor="end" fill="var(--gray-900)">
              {t}
            </text>
          </g>
        );
      })}

      {/* X ticks */}
      {xTicks.map((f) => {
        const x = padding + f * (plotRight - padding);
        return (
          <g key={`x${f}`}>
            <line x1={x} y1={plotBottom} x2={x} y2={plotBottom + 5} stroke="var(--gray-alpha-400)" />
            <text x={x} y={plotBottom + 20} fontSize={12} textAnchor="middle" fill="var(--gray-900)">
              {formatUsd(f * xMax)}
            </text>
          </g>
        );
      })}

      {/* Axes */}
      <line x1={padding} y1={plotBottom} x2={plotRight} y2={plotBottom} stroke="var(--gray-alpha-500)" />
      <line x1={padding} y1={plotTop} x2={padding} y2={plotBottom} stroke="var(--gray-alpha-500)" />

      {/* Axis titles */}
      <text
        x={padding + (plotRight - padding) / 2}
        y={height + 18}
        fontSize={13}
        textAnchor="middle"
        fill="var(--gray-900)"
        className="label"
      >
        Total inference cost (USD)
      </text>
      <text
        x={18}
        y={plotTop + (plotBottom - plotTop) / 2}
        fontSize={13}
        textAnchor="middle"
        fill="var(--gray-900)"
        className="label"
        transform={`rotate(-90 18 ${plotTop + (plotBottom - plotTop) / 2})`}
      >
        Tasks passed (of {yMax})
      </text>

      {/* Dots */}
      {items.map((item) => {
        const active = item.runId === hovered;
        const color = modelColor(item.model);
        return (
          <a key={item.runId} href={`/runs/${item.runId}`}>
            {/* Invisible larger hit area so hover/click is easy on small dots */}
            <circle
              cx={item.cx}
              cy={item.cy}
              r={14}
              fill="transparent"
              onMouseEnter={() => setHovered(item.runId)}
              onMouseLeave={() => setHovered((h) => (h === item.runId ? null : h))}
            />
            {/* Fill = model color (per-model comparison); baseline = dashed ring. */}
            {item.isBaseline ? (
              <circle
                cx={item.cx}
                cy={item.cy}
                r={active ? 8 : 6}
                fill="var(--background-100)"
                stroke={color}
                strokeWidth={2}
                strokeDasharray="2 2"
                pointerEvents="none"
              />
            ) : (
              <circle cx={item.cx} cy={item.cy} r={active ? 7.5 : 5.5} fill={color} pointerEvents="none" />
            )}
          </a>
        );
      })}

      {/* Hover tooltip (rendered last so it draws on top) */}
      {hoveredItem && <Tooltip item={hoveredItem} width={width} plotTop={plotTop} />}
    </svg>
  );
}

const AVATAR_SIZE = 16;

function Tooltip({ item, width, plotTop }: { item: ScatterItem; width: number; plotTop: number }) {
  const showAvatar = !item.isBaseline && item.githubLogin !== UNKNOWN_GITHUB_LOGIN;
  const line1 = item.isBaseline ? `${modelLabel(item.model)} Baseline` : item.githubLogin;
  const line2 = `${modelLabel(item.model)} · ${item.tasksPassed}/${item.totalTasks} · ${formatUsd(item.totalCostUsd)}`;
  const avatarGap = showAvatar ? AVATAR_SIZE + 6 : 0;
  const boxW = Math.max(line1.length * 7.2 + avatarGap, line2.length * 7.2) + 24;
  const boxH = 44;
  // Prefer above-right of the dot; flip left if it would overflow the right edge.
  const flipLeft = item.cx + 12 + boxW > width;
  const bx = flipLeft ? item.cx - 12 - boxW : item.cx + 12;
  const by = Math.max(plotTop, item.cy - boxH - 10);
  return (
    <g pointerEvents="none">
      <rect
        x={bx}
        y={by}
        width={boxW}
        height={boxH}
        rx={8}
        fill="var(--background-100)"
        stroke="var(--gray-alpha-500)"
      />
      {showAvatar && (
        <>
          <clipPath id={`avatar-clip-${item.runId}`}>
            <circle cx={bx + 12 + AVATAR_SIZE / 2} cy={by + 14} r={AVATAR_SIZE / 2} />
          </clipPath>
          <image
            href={`https://github.com/${item.githubLogin}.png`}
            x={bx + 12}
            y={by + 6}
            width={AVATAR_SIZE}
            height={AVATAR_SIZE}
            clipPath={`url(#avatar-clip-${item.runId})`}
          />
        </>
      )}
      <text x={bx + 12 + avatarGap} y={by + 18} fontSize={13} fontWeight={600} fill="var(--gray-1000)">
        {line1}
      </text>
      <text x={bx + 12} y={by + 34} fontSize={12} fill="var(--gray-900)" className="tabular-nums">
        {line2}
      </text>
    </g>
  );
}
