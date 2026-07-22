export interface SubmitResponse {
  submission_id: string;
  run_id?: string;
  status: string;
  judge_reason?: string;
}

export interface ParsedSubmitResponse {
  result: SubmitResponse | null;
  error: string | null;
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

  if (!response.ok) {
    return { result: body, error: body?.judge_reason ?? `HTTP ${response.status}` };
  }
  if (body) {
    return { result: body, error: null };
  }
  return { result: null, error: `HTTP ${response.status}` };
}
