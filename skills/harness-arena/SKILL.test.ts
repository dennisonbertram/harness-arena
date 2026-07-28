import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The path the skills.sh CLI walks (`skills/<name>/SKILL.md`), and the path
// GET /skill.md reads. If this moves, both break.
const skillPath = path.join(process.cwd(), "skills", "harness-arena", "SKILL.md");
const content = readFileSync(skillPath, "utf8");

function frontmatter(): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match) throw new Error("SKILL.md has no YAML frontmatter block");
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    if (!line.startsWith(" ") && line.includes(":")) {
      const [key, ...rest] = line.split(":");
      fields[key.trim()] = rest.join(":").trim();
    }
  }
  return fields;
}

describe("skills/harness-arena/SKILL.md", () => {
  describe("skills.sh format", () => {
    it("has the two frontmatter fields the format requires", () => {
      const fields = frontmatter();
      expect(fields.name).toBeTruthy();
      expect(fields.description).toBeTruthy();
    });

    it("uses a name the CLI accepts — lowercase, hyphens only", () => {
      expect(frontmatter().name).toMatch(/^[a-z0-9-]+$/);
    });

    it("describes when to use it, so an agent can decide from the description alone", () => {
      // The description is all an agent sees before loading the skill; a bare
      // "what it is" with no "when to use" makes it undiscoverable in practice.
      expect(frontmatter().description.toLowerCase()).toContain("use when");
    });
  });

  describe("tells an agent how to actually connect", () => {
    it("names the MCP server and how to register it", () => {
      expect(content).toContain("harness-arena-mcp");
      expect(content).toContain("mcp add");
    });

    it("explains that login needs a human to approve a device code", () => {
      // The one step an agent cannot do for itself. If the skill omits it, the
      // agent will silently hang on the poll loop.
      expect(content).toMatch(/device flow/i);
      expect(content).toContain("login");
    });

    it("names the tools an agent needs to compete", () => {
      for (const tool of ["get_baseline_prompt", "submit_prompt", "get_run", "list_competitions"]) {
        expect(content, `missing tool: ${tool}`).toContain(tool);
      }
    });
  });

  describe("states the scoring rules correctly", () => {
    // The previous version of this skill described a binary "pass every task,
    // then rank by cost" model the code no longer implements. These pin the
    // two rules actually in force so it cannot drift back.
    it("says the main arena ranks by pass rate over five runs", () => {
      expect(content).toMatch(/pass rate/i);
      expect(content).toContain("5");
    });

    it("says a competition entry gets one run, ranked by tasks solved", () => {
      expect(content).toMatch(/tasks solved/i);
    });

    it("does not repeat the retired complete-the-whole-test ranking", () => {
      expect(content).not.toMatch(/completes? the whole test/i);
    });

    it("states the real prompt size cap", () => {
      expect(content).toContain("32,768");
    });

    it("does not invent a prize figure — prizes come from competition data", () => {
      // prize_amount_usd is deliberately null until an admin sets it (#74).
      expect(content).not.toMatch(/\$\d/);
    });
  });
});
