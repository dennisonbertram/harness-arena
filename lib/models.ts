// The models a run can execute on, by Vercel AI Gateway id. glm-5.2 is the
// default and the reference the leaderboard was built around; the Claude models
// and poolside's Laguna are for cross-model comparison on the same
// tasks/harness. All route through the Vercel AI Gateway (one endpoint, one
// key) — the gateway serves Laguna too, so no separate provider is needed.
export const DEFAULT_MODEL = "zai/glm-5.2";

export const MODEL_LABELS: Record<string, string> = {
  "zai/glm-5.2": "glm-5.2",
  "anthropic/claude-sonnet-5": "Claude Sonnet 5",
  "anthropic/claude-opus-4-8": "Claude Opus 4.8",
  "poolside/laguna-s-2.1": "Laguna S 2.1",
};

// One shared model->color map so the chart, per-task bars, and any per-model
// labels use the SAME color for a model everywhere. Chosen to be distinct on
// the dark UI and reasonably colorblind-distinguishable.
export const MODEL_COLORS: Record<string, string> = {
  "zai/glm-5.2": "#4f9bf5", // blue
  "anthropic/claude-sonnet-5": "#e8912a", // amber
  "anthropic/claude-opus-4-8": "#a06fe0", // violet
  "poolside/laguna-s-2.1": "#2bb0a0", // teal
};
const FALLBACK_MODEL_COLOR = "#9aa0a6"; // gray for any unknown/legacy id

export function modelColor(model: string | undefined): string {
  return MODEL_COLORS[runModel(model)] ?? FALLBACK_MODEL_COLOR;
}

/** Ordered list of supported models (default first) for selectors/legends. */
export function modelOptions(): { id: string; label: string; color: string }[] {
  return Object.keys(MODEL_LABELS).map((id) => ({ id, label: MODEL_LABELS[id], color: MODEL_COLORS[id] ?? FALLBACK_MODEL_COLOR }));
}

/** Gateway ids a submission is allowed to request. */
export const ALLOWED_MODELS = new Set(Object.keys(MODEL_LABELS));

export function isAllowedModel(id: string): boolean {
  return ALLOWED_MODELS.has(id);
}

/** A run/submission's model, defaulting legacy (absent) records to glm-5.2. */
export function runModel(model: string | undefined): string {
  return model ?? DEFAULT_MODEL;
}

export function modelLabel(model: string | undefined): string {
  const id = runModel(model);
  return MODEL_LABELS[id] ?? id;
}
