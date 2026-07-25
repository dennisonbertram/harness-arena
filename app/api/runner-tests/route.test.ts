import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

const SECRET = "test-runner-secret";

function testsRequest(secret: string | null = SECRET): NextRequest {
  const headers: Record<string, string> = {};
  if (secret !== null) headers["x-runner-secret"] = secret;
  return new NextRequest("http://localhost/api/runner-tests", { method: "GET", headers });
}

describe("GET /api/runner-tests", () => {
  const originalSecret = process.env.RUNNER_CALLBACK_SECRET;

  beforeEach(() => {
    process.env.RUNNER_CALLBACK_SECRET = SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.RUNNER_CALLBACK_SECRET;
    else process.env.RUNNER_CALLBACK_SECRET = originalSecret;
  });

  it("returns 401 without a valid runner secret (grading materials never leak publicly)", async () => {
    expect((await GET(testsRequest("wrong"))).status).toBe(401);
    expect((await GET(testsRequest(null))).status).toBe(401);
  });

  it("returns every task's tests keyed by id, with a runnable test.sh, when the secret matches", async () => {
    const response = await GET(testsRequest());
    expect(response.status).toBe(200);

    const { tests } = await response.json();
    const ids = Object.keys(tests);
    expect(ids).toContain("fix-git");

    // test.sh is present for every task and decodes to non-empty shell.
    for (const id of ids) {
      const files = tests[id];
      expect(files["test.sh"], `${id} missing test.sh`).toBeDefined();
      expect(Buffer.from(files["test.sh"], "base64").length).toBeGreaterThan(0);
    }
  });

  it("decodes *.b64 grading files back to their real name (sanitize-git-repo)", async () => {
    const { tests } = await (await GET(testsRequest())).json();
    const files = tests["sanitize-git-repo"];
    // Delivered as test_outputs.py, never as the on-disk .b64 form.
    expect(files["test_outputs.py"]).toBeDefined();
    expect(files["test_outputs.py.b64"]).toBeUndefined();
    const decoded = Buffer.from(files["test_outputs.py"], "base64").toString("utf8");
    expect(decoded).toContain("terminal-bench-canary GUID");
  });
});
