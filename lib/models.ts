// The models a run can execute on, by Vercel AI Gateway id. glm-5.2 is the
// default and the reference the leaderboard was built around; the Claude models
// are for cross-model comparison on the same tasks/harness.
export const DEFAULT_MODEL = "zai/glm-5.2";

export const MODEL_LABELS: Record<string, string> = {
  "zai/glm-5.2": "glm-5.2",
  "anthropic/claude-sonnet-5": "Claude Sonnet 5",
  "anthropic/claude-opus-4-8": "Claude Opus 4.8",
};

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
