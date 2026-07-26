export interface SubmitResponse {
  submission_id?: string;
  /** First of the submission's runs (for a "view your run" link). */
  run_id?: string;
  /** All runs spawned for this submission (RUNS_PER_SUBMISSION of them). */
  run_ids?: string[];
  status?: string;
  judge_reason?: string;
  /** Error message from a non-2xx response (e.g. judge unavailable, rate limit). */
  error?: string;
}

export interface ParsedSubmitResponse {
  result: SubmitResponse | null;
  error: string | null;
  /** true when the judge rejected the prompt (a content verdict), false when
   *  the error is a system/infra failure — lets the UI use the right heading. */
  rejected: boolean;
  /** true on a 401 (session expired or never signed in) — distinct from a
   *  content rejection or a system failure, so the UI can offer a re-auth
   *  path instead of a generic error. */
  sessionExpired: boolean;
}

export interface MinimalFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Turns a fetch Response into a UI-ready {result, error} pair. Parses the
 * body defensively: a body that isn't valid JSON (e.g. an upstream proxy's
 * HTML error page on a 502) falls back to "HTTP <status>" instead of
 * throwing.
 */
export async function parseSubmitResponse(response: MinimalFetchResponse): Promise<ParsedSubmitResponse> {
  let body: SubmitResponse | null = null;
  try {
    body = (await response.json()) as SubmitResponse;
  } catch {
    body = null;
  }

  // Non-2xx: an infra/system error (judge unavailable, rate limit, too large)
  // or a 401 (no/expired session). Surface the server's own message
  // (body.error), never a bare "HTTP 503".
  if (!response.ok) {
    return {
      result: body,
      error: body?.error ?? body?.judge_reason ?? `The server returned HTTP ${response.status}.`,
      rejected: false,
      sessionExpired: response.status === 401,
    };
  }
  // A content rejection comes back 200 with status "rejected" — show its reason.
  if (body?.status === "rejected") {
    return {
      result: body,
      error: body.judge_reason ?? "The fairness judge rejected this prompt.",
      rejected: true,
      sessionExpired: false,
    };
  }
  if (body) {
    return { result: body, error: null, rejected: false, sessionExpired: false };
  }
  return {
    result: null,
    error: `The server returned HTTP ${response.status}.`,
    rejected: false,
    sessionExpired: false,
  };
}
