import type { Progress } from "./voice-session";
import { VOICE_JUDGMENT_REASONS, VOICE_OUTCOMES } from "./voice-types";
import type { VoicePlayCounts } from "./voice-types";

export type VoiceOutcome = (typeof VOICE_OUTCOMES)[number];
export type VoiceReason = (typeof VOICE_JUDGMENT_REASONS)[number];
export type ClipKey = "prompt" | "a" | "b";

const EXCLUDE_CAP = 25;

/** Appends `id` to the session-local exclude list, deduped, capped at the 25 most-recent. */
export function appendExclude(excludeIds: readonly string[], id: string): string[] {
  const next = [...excludeIds.filter((existing) => existing !== id), id];
  return next.length > EXCLUDE_CAP ? next.slice(-EXCLUDE_CAP) : next;
}

/** `/api/voice/next` URL for the given exclude list — comma-joined per the API contract. */
export function voiceNextUrl(excludeIds: readonly string[]): string {
  return excludeIds.length > 0 ? `/api/voice/next?exclude=${excludeIds.join(",")}` : "/api/voice/next";
}

/** 5xx or a network failure is treated as retryable; any 4xx is treated as a rejection (stale IDs, lost cookie, etc). */
export function isRetryableStatus(status: number): boolean {
  return status >= 500;
}

// ---------------------------------------------------------------------------
// GET /api/voice/next response payload (the blinded comparison the client renders)
// ---------------------------------------------------------------------------

export interface ComparisonPayload {
  comparisonId: string;
  prompt: { audioUrl: string; text?: string };
  clipA: { responseId: string; audioUrl: string };
  clipB: { responseId: string; audioUrl: string };
  progress: Progress;
}

export type NextResult =
  | { kind: "not_seeded" }
  | { kind: "done"; progress: Progress }
  | { kind: "comparison"; comparison: ComparisonPayload }
  | { kind: "error"; message: string };

export interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Mirrors lib/submit-response.ts's parseSubmitResponse: turn a fetch Response into a typed, testable result. */
export async function parseNextResponse(response: MinimalFetchResponse): Promise<NextResult> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : `The server returned HTTP ${response.status}.`;
    return { kind: "error", message };
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (record.not_seeded) return { kind: "not_seeded" };
    if (record.done) return { kind: "done", progress: record.progress as Progress };
    if (typeof record.comparisonId === "string") return { kind: "comparison", comparison: body as ComparisonPayload };
  }
  return { kind: "error", message: "Unexpected response from the server." };
}

// ---------------------------------------------------------------------------
// POST /api/voice/judgments payload + response parsing
// ---------------------------------------------------------------------------

export interface JudgmentPayload {
  response_a_id: string;
  response_b_id: string;
  outcome: VoiceOutcome;
  reason?: VoiceReason;
  free_text?: string;
  play_counts: VoicePlayCounts;
  time_to_judgment_ms: number;
}

export type PostJudgmentResult =
  | { kind: "stored" }
  | { kind: "retryable"; message: string }
  | { kind: "rejected"; message: string };

export async function parseJudgmentResponse(response: MinimalFetchResponse): Promise<PostJudgmentResult> {
  if (response.ok) return { kind: "stored" };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : `The server returned HTTP ${response.status}.`;
  return isRetryableStatus(response.status) ? { kind: "retryable", message } : { kind: "rejected", message };
}

// ---------------------------------------------------------------------------
// Flow state machine
// ---------------------------------------------------------------------------

interface BaseState {
  excludeIds: string[];
}

export interface PendingState extends BaseState {
  phase: "pending";
  notice?: string;
}
export interface NotSeededState extends BaseState {
  phase: "not_seeded";
}
export interface DoneState extends BaseState {
  phase: "done";
  progress: Progress;
}

export interface ActiveFlowState extends BaseState {
  phase: "comparing" | "voted" | "diagnostic" | "submitting";
  comparison: ComparisonPayload;
  loadedAt: number;
  playCounts: VoicePlayCounts;
  outcome?: VoiceOutcome;
  votedAt?: number; // timestamp of the FIRST vote action — not updated on later vote changes
  reason?: VoiceReason;
  freeText: string;
  audioError?: ClipKey;
  submitError?: { kind: "retryable"; message: string };
  pendingPayload?: JudgmentPayload; // frozen at "submit"/"retrySubmit" time; Retry resends this unchanged
}

export type VoiceFlowState = PendingState | NotSeededState | DoneState | ActiveFlowState;

export type VoiceFlowAction =
  | { type: "loaded"; comparison: ComparisonPayload; loadedAt: number }
  | { type: "notSeeded" }
  | { type: "allDone"; progress: Progress }
  | { type: "played"; clip: ClipKey }
  | { type: "audioErrored"; clip: ClipKey }
  | { type: "clearAudioError" }
  | { type: "vote"; outcome: VoiceOutcome; now: number }
  | { type: "setReason"; reason: VoiceReason }
  | { type: "setFreeText"; text: string }
  | { type: "submit" }
  | { type: "retrySubmit" }
  | { type: "submitSucceeded"; comparisonId: string }
  | { type: "submitFailedRetryable"; message: string }
  | { type: "submitFailedRejected"; message: string }
  | { type: "skip"; comparisonId: string };

export const initialVoiceFlowState: VoiceFlowState = { phase: "pending", excludeIds: [] };

export function isActiveState(state: VoiceFlowState): state is ActiveFlowState {
  return (
    state.phase === "comparing" || state.phase === "voted" || state.phase === "diagnostic" || state.phase === "submitting"
  );
}

function isEditable(state: VoiceFlowState): state is ActiveFlowState {
  return isActiveState(state) && state.phase !== "submitting";
}

function activePhase(outcome: VoiceOutcome | undefined, reason: VoiceReason | undefined): "comparing" | "voted" | "diagnostic" {
  if (outcome && reason) return "diagnostic";
  if (outcome) return "voted";
  return "comparing";
}

/** The judgment POST body for a ready-to-submit active state — never includes an evaluator id. */
export function buildJudgmentPayload(state: ActiveFlowState): JudgmentPayload | undefined {
  if (!state.outcome || !state.reason || state.votedAt === undefined) return undefined;
  return {
    response_a_id: state.comparison.clipA.responseId,
    response_b_id: state.comparison.clipB.responseId,
    outcome: state.outcome,
    reason: state.reason,
    free_text: state.freeText.trim() ? state.freeText : undefined,
    play_counts: state.playCounts,
    time_to_judgment_ms: state.votedAt - state.loadedAt,
  };
}

export function voiceFlowReducer(state: VoiceFlowState, action: VoiceFlowAction): VoiceFlowState {
  switch (action.type) {
    case "loaded":
      return {
        phase: "comparing",
        excludeIds: state.excludeIds,
        comparison: action.comparison,
        loadedAt: action.loadedAt,
        playCounts: { prompt: 0, a: 0, b: 0 },
        freeText: "",
      };

    case "notSeeded":
      return { phase: "not_seeded", excludeIds: state.excludeIds };

    case "allDone":
      return { phase: "done", excludeIds: state.excludeIds, progress: action.progress };

    case "played": {
      if (!isActiveState(state)) return state;
      return { ...state, playCounts: { ...state.playCounts, [action.clip]: state.playCounts[action.clip] + 1 } };
    }

    case "audioErrored": {
      if (!isActiveState(state)) return state;
      return { ...state, audioError: action.clip };
    }

    case "clearAudioError": {
      if (!isActiveState(state)) return state;
      return { ...state, audioError: undefined };
    }

    case "vote": {
      if (!isEditable(state)) return state;
      const outcome = action.outcome;
      const votedAt = state.votedAt ?? action.now; // first vote's timestamp only
      return { ...state, outcome, votedAt, phase: activePhase(outcome, state.reason), submitError: undefined };
    }

    case "setReason": {
      if (!isEditable(state)) return state;
      return { ...state, reason: action.reason, phase: activePhase(state.outcome, action.reason), submitError: undefined };
    }

    case "setFreeText": {
      if (!isEditable(state)) return state;
      return { ...state, freeText: action.text, submitError: undefined };
    }

    case "submit": {
      if (!isEditable(state) || state.phase !== "diagnostic") return state;
      const payload = buildJudgmentPayload(state);
      if (!payload) return state;
      return { ...state, phase: "submitting", pendingPayload: payload, submitError: undefined };
    }

    case "retrySubmit": {
      if (!isActiveState(state) || state.phase !== "diagnostic" || !state.pendingPayload) return state;
      return { ...state, phase: "submitting", submitError: undefined };
    }

    case "submitSucceeded": {
      if (!isActiveState(state) || state.phase !== "submitting") return state;
      return { phase: "pending", excludeIds: appendExclude(state.excludeIds, action.comparisonId) };
    }

    case "submitFailedRetryable": {
      if (!isActiveState(state) || state.phase !== "submitting") return state;
      return { ...state, phase: "diagnostic", submitError: { kind: "retryable", message: action.message } };
    }

    case "submitFailedRejected": {
      if (!isActiveState(state) || state.phase !== "submitting") return state;
      return { phase: "pending", excludeIds: state.excludeIds, notice: action.message };
    }

    case "skip": {
      if (!isActiveState(state)) return state;
      return { phase: "pending", excludeIds: appendExclude(state.excludeIds, action.comparisonId) };
    }
  }
}
