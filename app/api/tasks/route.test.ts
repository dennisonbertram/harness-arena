import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/tasks", () => {
  it("only returns task ids and descriptions, never task execution or test details", async () => {
    const response = await GET();
    const tasks = await response.json();
    expect(response.status).toBe(200);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0]).toEqual({ id: expect.any(String), description: expect.any(String) });
    expect(JSON.stringify(tasks)).not.toContain("tests/test.sh");
    expect(JSON.stringify(tasks)).not.toContain("dockerImage");
  });
});
