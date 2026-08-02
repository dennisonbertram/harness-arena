import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseRunbook = readFileSync(new URL("../../docs/runbooks/competition-release.md", import.meta.url), "utf8");
const providerInvestigation = readFileSync(
  new URL("../../docs/provider-stream-failure-ab.md", import.meta.url),
  "utf8",
);

describe("release documentation contracts", () => {
  it("uses only passive cursor-based run events in shell monitoring examples", () => {
    const shellBlocks = [...releaseRunbook.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
    const runApiTargets = shellBlocks.flatMap((block) => block.match(/\/api\/runs[^\s'"\\]*/g) ?? []);

    expect(runApiTargets.length).toBeGreaterThan(0);
    expect(runApiTargets.every((target) => /^\/api\/runs\/[^/]+\/events\?since=/.test(target))).toBe(true);
  });

  it("contains no trailing whitespace in the provider stream record", () => {
    expect(providerInvestigation.split("\n").filter((line) => /[ \t]+$/.test(line))).toEqual([]);
  });
});
