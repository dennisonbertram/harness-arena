import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const agents = await readFile(resolve(repositoryRoot, "AGENTS.md"), "utf8");
const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8"));
const initSource = await readFile(resolve(repositoryRoot, "scripts/init.mjs"), "utf8");

function extractStartHere(document) {
  const heading = "# Start here";
  const start = document.indexOf(heading);
  if (start < 0) return "";

  const remainder = document.slice(start + heading.length);
  const nextHeading = remainder.search(/\n# [^#\n]/);
  return document.slice(start, nextHeading < 0 ? document.length : start + heading.length + nextHeading);
}

function markdownLinks(document) {
  return [...document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
}

const startHere = extractStartHere(agents);

describe("agent onboarding contract", () => {
  it("derives a credential-free start path from supported repository commands", () => {
    const validArgs = initSource.match(/const validArgs = new Set\(\[([^\]]+)]\)/)?.[1] ?? "";
    const checkFlag = [...validArgs.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .find((flag) => flag.includes("check"));
    const qualityCommands = Object.entries(packageJson.scripts)
      .filter(([, implementation]) => /(?:vitest run$|tsc --noEmit$|build-with-nft-guard)/.test(implementation))
      .map(([name]) => `pnpm ${name}`);

    expect(startHere).toMatch(/^# Start here/m);
    expect(checkFlag).toBeDefined();
    expect(startHere).toContain(`\`./scripts/init.sh ${checkFlag}\``);
    expect(startHere).toContain("`./scripts/init.sh`");
    expect(qualityCommands).toHaveLength(3);
    for (const command of qualityCommands) expect(startHere).toContain(`\`${command}\``);
    expect(startHere).toMatch(/local coding needs no hosted credentials/i);
  });

  it("keeps every Start here link local, readable, and non-empty", async () => {
    const links = markdownLinks(startHere);
    expect(links.length).toBeGreaterThan(5);

    for (const link of links) {
      expect(link).not.toMatch(/^(?:[a-z]+:|#)/i);
      const target = resolve(repositoryRoot, link);
      expect(target.startsWith(`${repositoryRoot}/`)).toBe(true);
      expect((await stat(target)).isFile()).toBe(true);
      expect((await readFile(target, "utf8")).trim()).not.toBe("");
    }
  });

  it("links authoritative maps and preserves the three-environment safety boundary", async () => {
    const linkedContents = await Promise.all(
      markdownLinks(startHere).map((link) => readFile(resolve(repositoryRoot, link), "utf8")),
    );
    const mappedDirectories = [...startHere.matchAll(/`([^`]+\/)`/g)].map((match) => match[1]);

    expect(mappedDirectories.length).toBeGreaterThanOrEqual(4);
    for (const directory of mappedDirectories) {
      expect((await stat(resolve(repositoryRoot, directory))).isDirectory()).toBe(true);
    }
    expect(startHere).toMatch(/local.*`STORAGE=file`/is);
    expect(startHere).toMatch(/Development.*`dev`.*native Git/is);
    expect(startHere).toMatch(/production.*read-only.*never.*mutat/is);
    expect(startHere).toMatch(/external\s+observer\s+credentials\s+are\s+optional\s+and\s+operator-only/is);
    expect(linkedContents.some((content) => /STORAGE=file/.test(content))).toBe(true);
    expect(linkedContents.some((content) => /Production Branch[^\n]*`dev`/i.test(content))).toBe(true);
    expect(linkedContents.some((content) => /OPS_READ_TOKEN/.test(content))).toBe(true);
    expect(linkedContents.some((content) => /harness-arena-development/.test(content))).toBe(true);
  });

  it("describes the source-backed pre-run fairness and execution flow", async () => {
    const linkedSources = await Promise.all(
      markdownLinks(startHere)
        .filter((link) => /\.(?:ts|mjs)$/.test(link))
        .map(async (link) => ({ link, content: await readFile(resolve(repositoryRoot, link), "utf8") })),
    );
    const sourceFor = (symbol) => linkedSources.find(({ content }) => content.includes(symbol));
    const runnerSource = linkedSources.find(({ content }) =>
      ["preflightProxy", "runOneTask", "flushEvents", "uploadAgentTraces", "task_results:"].every((symbol) =>
        content.includes(symbol),
      ),
    );

    expect(sourceFor("judgeSubmission")).toBeDefined();
    expect(sourceFor("dispatchQueuedRuns")).toBeDefined();
    expect(sourceFor("Sandbox.create")).toBeDefined();
    expect(sourceFor("buildRunnerTasks")).toBeDefined();
    expect(runnerSource).toBeDefined();
    expect(sourceFor("aggregatePrompts")).toBeDefined();
    expect(sourceFor("createOpsReadService")).toBeDefined();

    expect(sourceFor("judgeSubmission").content).toMatch(/fairness/i);
    expect(startHere).toMatch(/fairness gate.*before dispatch/is);
    expect(startHere).toMatch(/dispatch.*Sandbox.*Vercel Sandboxes/is);
    expect(startHere).toMatch(/derived task\s+manifest/is);
    expect(startHere).toMatch(/runner.*executes.*AI Gateway.*authenticated callbacks.*traces\/results/is);
    expect(startHere).toMatch(/persisted events\/results.*scoring\/UI/is);
    expect(startHere).not.toMatch(/judge.*consume persisted/is);
  });

  it("makes Epic-first and red-first delivery discoverable before implementation", () => {
    expect(startHere).toMatch(/Before implementation.*Epic.*native GitHub (?:subissue|child)/is);
    expect(startHere).toMatch(/Red first.*test.*fail/is);
  });
});
