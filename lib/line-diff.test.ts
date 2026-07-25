import { describe, expect, it } from "vitest";
import { diffLines, diffStat } from "./line-diff";

describe("diffLines", () => {
  it("marks unchanged lines as same", () => {
    const d = diffLines("a\nb\nc", "a\nb\nc");
    expect(d.every((l) => l.type === "same")).toBe(true);
    expect(d.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("detects an added line", () => {
    const d = diffLines("a\nc", "a\nb\nc");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "add", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("detects a removed line", () => {
    const d = diffLines("a\nb\nc", "a\nc");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "same", text: "c" },
    ]);
  });

  it("detects a changed line as a remove + add", () => {
    const d = diffLines("hello\nworld", "hello\nthere");
    expect(d).toEqual([
      { type: "same", text: "hello" },
      { type: "del", text: "world" },
      { type: "add", text: "there" },
    ]);
    expect(diffStat(d)).toEqual({ added: 1, removed: 1 });
  });

  it("an empty submission removes the whole baseline", () => {
    const d = diffLines("x\ny", "");
    // "" splits to [""], so one same-ish empty line can appear; assert the
    // baseline lines are all removed.
    expect(d.filter((l) => l.type === "del").map((l) => l.text)).toEqual(["x", "y"]);
    expect(diffStat(d).removed).toBe(2);
  });
});
