import { afterEach, describe, expect, it, vi } from "vitest";
import { JUDGE_MODEL, judgeSubmission } from "./judge";

const FIXTURE_TASKS = [
  { id: "regex-log", instruction: "Extract lines matching a pattern from a log file." },
  { id: "sqlite-db-truncate", instruction: "Truncate a table in a SQLite database file." },
];

function mockFetchOnce(body: string, ok = true, status = 200) {
  return vi.fn().mockResolvedValueOnce({
    ok,
    status,
    json: async () => ({ choices: [{ message: { content: body } }] }),
  });
}

describe("judgeSubmission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an approved verdict when the gateway responds with an approve JSON verdict", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(JSON.stringify({ verdict: "approved", reason: "Generic strategy advice only." })),
    );

    const result = await judgeSubmission("Plan before acting. Minimize turns.", FIXTURE_TASKS);

    expect(result).toEqual({ verdict: "approved", reason: "Generic strategy advice only." });
  });

  it("returns a rejected verdict with the judge's reason when the gateway rejects", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce(
        JSON.stringify({
          verdict: "rejected",
          reason: "Embeds the literal regex answer for the regex-log task.",
        }),
      ),
    );

    const result = await judgeSubmission("For regex-log, run: grep -P '...' file", FIXTURE_TASKS);

    expect(result).toEqual({
      verdict: "rejected",
      reason: "Embeds the literal regex answer for the regex-log task.",
    });
  });

  it("strips markdown code fences before parsing the verdict JSON", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchOnce('```json\n{"verdict": "approved", "reason": "Fine."}\n```'),
    );

    const result = await judgeSubmission("Be a good agent.", FIXTURE_TASKS);

    expect(result).toEqual({ verdict: "approved", reason: "Fine." });
  });

  it("sends the rubric system prompt verbatim and the prompt+task instructions in the user message", async () => {
    const fetchMock = mockFetchOnce(JSON.stringify({ verdict: "approved", reason: "ok" }));
    vi.stubGlobal("fetch", fetchMock);

    await judgeSubmission("my submitted prompt", FIXTURE_TASKS);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: expect.stringContaining("Bearer") }),
      }),
    );

    const [, options] = fetchMock.mock.calls[0];
    const requestBody = JSON.parse(options.body as string);

    expect(requestBody.model).toBe(JUDGE_MODEL);
    expect(requestBody.temperature).toBe(0.1);
    expect(requestBody.max_tokens).toBe(300);
    expect(requestBody.messages[0].role).toBe("system");
    expect(requestBody.messages[0].content).toContain("fairness judge for Harness Arena");
    expect(requestBody.messages[0].content).toContain("REJECT when the prompt contains any of");
    expect(requestBody.messages[1].content).toContain("my submitted prompt");
    expect(requestBody.messages[1].content).toContain("regex-log");
    expect(requestBody.messages[1].content).toContain("Extract lines matching a pattern from a log file.");
  });

  it("retries once on unparseable output, then rejects with a resubmit reason if the retry also fails to parse", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "not json at all" } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "still not json" } }] }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await judgeSubmission("some prompt", FIXTURE_TASKS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ verdict: "rejected", reason: "judge output unparseable — resubmit" });
  });

  it("recovers on the retry if the second gateway response parses correctly", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "garbage" } }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ verdict: "approved", reason: "ok on retry" }) } }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await judgeSubmission("some prompt", FIXTURE_TASKS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ verdict: "approved", reason: "ok on retry" });
  });

  describe("regression: infra failures must not be swallowed as a rejection", () => {
    it("throws (does not return a rejected verdict) when the gateway responds with a 500", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) }),
      );

      await expect(judgeSubmission("some prompt", FIXTURE_TASKS)).rejects.toThrow();
    });

    it("throws (does not return a rejected verdict) on a network error", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("network down")));

      await expect(judgeSubmission("some prompt", FIXTURE_TASKS)).rejects.toThrow("network down");
    });
  });
});
