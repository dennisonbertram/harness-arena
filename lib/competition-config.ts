import { isAllowedModel } from "./models";

// The one model the /competition contest runs on. Fixed for the whole
// competition (no per-submission choice) — the admin picks this via env var,
// not through an "add a model" UI. Vercel exposes GLM's guaranteed fast tier
// as a distinct model slug rather than as a provider option on zai/glm-5.2.
export const COMPETITION_MODEL = process.env.COMPETITION_MODEL ?? "zai/glm-5.2-fast";

if (!isAllowedModel(COMPETITION_MODEL)) {
  // Fail fast at boot, not silently at request time — an invalid override
  // would otherwise only surface the first time someone hits the admin or
  // submission endpoint.
  throw new Error(`COMPETITION_MODEL "${COMPETITION_MODEL}" is not in ALLOWED_MODELS`);
}

/** Reads the configured admin token, or undefined if unset. */
export function competitionAdminToken(): string | undefined {
  const token = process.env.COMPETITION_ADMIN_TOKEN;
  return token && token !== process.env.OPS_READ_TOKEN ? token : undefined;
}
