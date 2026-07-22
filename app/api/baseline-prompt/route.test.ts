import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/baseline-prompt", () => {
  it("serves docs/pi-vanilla-system-prompt.txt as text/plain", async () => {
    const response = await GET();
    const text = await response.text();
    const expected = readFileSync(
      path.join(process.cwd(), "docs", "pi-vanilla-system-prompt.txt"),
      "utf8",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(text).toBe(expected);
  });
});
