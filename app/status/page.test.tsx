import { describe, expect, it } from "vitest";
import * as StatusPage from "./page";

describe("status page revalidation", () => {
  it("exports a 10-second ISR revalidate window per the task contract", () => {
    expect(StatusPage.revalidate).toBe(10);
  });
});
