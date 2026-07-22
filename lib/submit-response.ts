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
 * Turns a fetch Response into a UI-ready {result, error} pair.
 * TODO(TASK-8-review): stub — calls response.json() unconditionally, so a
 * non-JSON body (e.g. an upstream proxy's HTML error page) throws instead of
 * falling back to "HTTP <status>".
 */
export async function parseSubmitResponse(response: MinimalFetchResponse): Promise<ParsedSubmitResponse> {
  const body = (await response.json()) as SubmitResponse;
  if (!response.ok) {
    return { result: body, error: body?.judge_reason ?? "Submission failed." };
  }
  return { result: body, error: null };
}
