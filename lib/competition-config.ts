import { isAllowedModel } from "./models";

// The one model the /competition contest runs on. Fixed for the whole
// competition (no per-submission choice) — the admin picks this via env var,
// not through an "add a model" UI. Defaults to glm-5.2: already the app's
// DEFAULT_MODEL, already registered in ALLOWED_MODELS, open-weight (Z.ai's
// GLM family), and the cheapest model in the existing palette (~$1/run).
export const COMPETITION_MODEL = process.env.COMPETITION_MODEL ?? "zai/glm-5.2";

if (!isAllowedModel(COMPETITION_MODEL)) {
  // Fail fast at boot, not silently at request time — an invalid override
  // would otherwise only surface the first time someone hits the admin or
  // submission endpoint.
  throw new Error(`COMPETITION_MODEL "${COMPETITION_MODEL}" is not in ALLOWED_MODELS`);
}

/** Reads the configured admin token, or undefined if unset. */
export function competitionAdminToken(): string | undefined {
  return process.env.COMPETITION_ADMIN_TOKEN;
}
