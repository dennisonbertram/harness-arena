import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /skill.md", () => {
  it("serves skills/harness-arena/SKILL.md content as text/markdown", async () => {
    const response = await GET();
    const text = await response.text();
    const expected = readFileSync(path.join(process.cwd(), "skills", "harness-arena", "SKILL.md"), "utf8");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(text).toBe(expected);
  });
});
