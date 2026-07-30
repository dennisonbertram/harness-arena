import { formatDuration } from "@/lib/format";
import { modelColor, modelLabel } from "@/lib/models";
import type { TaskModelSummary } from "@/lib/aggregate";

export function TaskModelPerformanceChart({ models }: { models: TaskModelSummary[] }) {
  const maxTurns = Math.max(...models.map((model) => model.meanTurns), 1);
  const maxDurationS = Math.max(...models.map((model) => model.meanDurationS ?? 0), 1);
  const maxOutputTokensPerSecond = Math.max(...models.map((model) => model.outputTokensPerSecond ?? 0), 1);

  return (
    <div
      role="img"
      aria-label="Performance by model: pass rate, mean turns, mean wall-clock time, and output tokens per second"
      style={{
        display: "grid",
        gap: 12,
        padding: 16,
        marginBottom: 28,
        border: "1px solid var(--gray-alpha-400)",
        borderRadius: 10,
        background: "var(--background-100)",
      }}
    >
      <div
        className="label"
        style={{ display: "grid", gridTemplateColumns: "minmax(130px, 1.2fr) repeat(4, minmax(100px, 1fr))", gap: 16 }}
      >
        <span>Model</span>
        <span>Pass rate</span>
        <span>Mean turns</span>
        <span>Mean wall time</span>
        <span>Output tok/s</span>
      </div>
      {models.map((model) => (
        <div
          key={model.model}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(130px, 1.2fr) repeat(4, minmax(100px, 1fr))",
            gap: 16,
            alignItems: "center",
          }}
        >
          <div style={{ minWidth: 0, fontSize: 13 }}>
            <span aria-hidden="true" style={{ color: modelColor(model.model), marginRight: 6 }}>●</span>
            {modelLabel(model.model)}
          </div>
          <MetricBar
            metric="pass-rate"
            model={model.model}
            value={`${(model.passRate * 100).toFixed(0)}% (${model.passed}/${model.attempts})`}
            fraction={model.passRate}
            color={modelColor(model.model)}
          />
          <MetricBar
            metric="turns"
            model={model.model}
            value={model.meanTurns.toFixed(1)}
            fraction={model.meanTurns / maxTurns}
            color={modelColor(model.model)}
          />
          {model.meanDurationS === null ? (
            <span className="tabular-nums" style={{ color: "var(--gray-700)", fontSize: 13 }}>unmeasured</span>
          ) : (
            <MetricBar
              metric="duration"
              model={model.model}
              value={formatDuration(model.meanDurationS)}
              fraction={model.meanDurationS / maxDurationS}
              color={modelColor(model.model)}
            />
          )}
          {model.outputTokensPerSecond === null ? (
            <span className="tabular-nums" style={{ color: "var(--gray-700)", fontSize: 13 }}>unmeasured</span>
          ) : (
            <MetricBar
              metric="output-tokens-per-second"
              model={model.model}
              value={`${model.outputTokensPerSecond.toFixed(1)} tok/s`}
              fraction={model.outputTokensPerSecond / maxOutputTokensPerSecond}
              color={modelColor(model.model)}
            />
          )}
        </div>
      ))}
      <p style={{ margin: 0, fontSize: 12, color: "var(--gray-700)" }}>
        Bars compare models within each metric; wall time and output throughput use only recorded measurements.
      </p>
    </div>
  );
}

function MetricBar({
  metric,
  model,
  value,
  fraction,
  color,
}: {
  metric: "pass-rate" | "turns" | "duration" | "output-tokens-per-second";
  model: string;
  value: string;
  fraction: number;
  color: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ height: 7, overflow: "hidden", borderRadius: 999, background: "var(--gray-alpha-300)", marginBottom: 4 }}>
        <div
          data-metric={metric}
          data-model={model}
          style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, height: "100%", borderRadius: "inherit", background: color }}
        />
      </div>
      <span className="tabular-nums" style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}
