import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/health", () => {
  it("returns 200 with ok:true and a sha string", async () => {
    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.sha).toBe("string");
    expect(body.sha.length).toBeGreaterThan(0);
  });
});
