import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CANARY_GUID,
  SWE_MANIFEST,
  parseTestList,
  toTaskSpec,
  vendorFromRawDir,
} from "./vendor-swe-tasks.mjs";

function rawInstance(overrides = {}) {
  return {
    instance_id: SWE_MANIFEST[0].id,
    repo: SWE_MANIFEST[0].repo,
    base_commit: SWE_MANIFEST[0].base_commit,
    problem_statement: "Something is broken in the ORM.",
    FAIL_TO_PASS: JSON.stringify(["tests/test_orm.py::test_new_behavior"]),
    PASS_TO_PASS: JSON.stringify(["tests/test_orm.py::test_old_behavior"]),
    ...overrides,
  };
}

describe("toTaskSpec", () => {
  it("builds a spec with the issue as instruction and no solution material", () => {
    const spec = toTaskSpec(rawInstance());
    expect(spec.id).toBe(SWE_MANIFEST[0].id);
    expect(spec.issue_text).toBe("Something is broken in the ORM.");
    expect(spec.fail_to_pass).toEqual(["tests/test_orm.py::test_new_behavior"]);
    expect(JSON.stringify(spec)).not.toMatch(/gold_patch|test_patch/);
    expect(spec.canary).toBe(CANARY_GUID);
  });

  it("REFUSES an instance still carrying a gold patch (solutions never vendored)", () => {
    expect(() => toTaskSpec(rawInstance({ gold_patch: "diff --git a/x b/x" }))).toThrow(
      /refusing to vendor/,
    );
  });

  it("REFUSES an instance still carrying a test patch", () => {
    expect(() => toTaskSpec(rawInstance({ test_patch: "diff --git a/t b/t" }))).toThrow(
      /refusing to vendor/,
    );
  });

  it("rejects an empty FAIL_TO_PASS list as unverifiable", () => {
    expect(() => toTaskSpec(rawInstance({ FAIL_TO_PASS: "[]" }))).toThrow(/unverifiable/);
  });

  it("throws a clear error on a missing required field", () => {
    const { problem_statement, ...withoutIssue } = rawInstance();
    void problem_statement;
    expect(() => toTaskSpec(withoutIssue)).toThrow(/problem_statement/);
  });
});

describe("parseTestList", () => {
  it("parses the dataset's stringified-array form", () => {
    expect(parseTestList('["a::t1", "a::t2"]')).toEqual(["a::t1", "a::t2"]);
  });

  it("passes through real arrays and empty strings", () => {
    expect(parseTestList(["x"])).toEqual(["x"]);
    expect(parseTestList("")).toEqual([]);
  });

  it("throws on a non-array JSON value", () => {
    expect(() => parseTestList('{"not":"a list"}')).toThrow(/not an array/);
  });
});

describe("vendorFromRawDir", () => {
  it("vendors exactly the manifest instances, ignoring non-manifest strays", () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "swe-raw-"));
    try {
      for (const entry of SWE_MANIFEST) {
        writeFileSync(path.join(rawDir, `${entry.id}.json`), JSON.stringify(rawInstance({
          instance_id: entry.id,
          repo: entry.repo,
          base_commit: entry.base_commit,
        })));
      }
      // One stray file that is NOT in the manifest must be ignored.
      writeFileSync(path.join(rawDir, "stray__repo-999.json"), JSON.stringify(rawInstance({ instance_id: "stray__repo-999" })));

      // Run against a one-entry scratch manifest to keep the repo tree untouched.
      const single = [SWE_MANIFEST[0]];
      const ids = vendorFromRawDirInto(rawDir, single);
      expect(ids).toEqual([SWE_MANIFEST[0].id]);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  it("aborts when fetched base_commit differs from the pinned manifest commit", () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "swe-raw-"));
    try {
      writeFileSync(
        path.join(rawDir, `${SWE_MANIFEST[0].id}.json`),
        JSON.stringify(rawInstance({ base_commit: "0000000000000000000000000000000000000000" })),
      );
      expect(() => vendorFromRawDirInto(rawDir, [SWE_MANIFEST[0]])).toThrow(/!= pinned/);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });

  it("fails with a clear error when a manifest instance has no raw file", () => {
    const rawDir = mkdtempSync(path.join(tmpdir(), "swe-raw-"));
    try {
      expect(() => vendorFromRawDirInto(rawDir, [SWE_MANIFEST[1]])).toThrow(/missing raw instance/);
    } finally {
      rmSync(rawDir, { recursive: true, force: true });
    }
  });
});

// Drive vendorFromRawDir against a temp output location by stubbing the
// module-level TASKS_SWE_DIR through a re-import with query param would be
// overkill; instead exercise the real function but restore any repo-tree
// writes. The repo tasks-swe/ dir does not exist yet (board not shipped), so
// guard: if the test created it, remove it.
function vendorFromRawDirInto(rawDir, manifest) {
  const target = path.join(process.cwd(), "tasks-swe");
  const existed = existsSync(target);
  try {
    return vendorFromRawDir(rawDir, manifest);
  } finally {
    if (!existed) rmSync(target, { recursive: true, force: true });
  }
}
