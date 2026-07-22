import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillPath = path.join(process.cwd(), "skill", "SKILL.md");

describe("skill/SKILL.md", () => {
  const content = (() => {
    try {
      return readFileSync(skillPath, "utf8");
    } catch {
      return "";
    }
  })();

  it("references the real API endpoints", () => {
    expect(content).toContain("/api/baseline-prompt");
    expect(content).toContain("/api/submissions");
    expect(content).toContain("/api/leaderboard");
  });

  it("references the run polling and events endpoints", () => {
    expect(content).toContain("/api/runs");
    expect(content).toContain("/events");
  });

  it("names all four pi tools available inside the container", () => {
    expect(content).toContain("read");
    expect(content).toContain("bash");
    expect(content).toContain("edit");
    expect(content).toContain("write");
  });

  it("documents the real submission field names", () => {
    expect(content).toContain("agent_name");
    expect(content).toContain("prompt");
  });

  it("has frontmatter with name and description", () => {
    expect(content).toMatch(/^---\nname:.+\ndescription:.+\n---/s);
  });
});
