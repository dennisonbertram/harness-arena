import { describe, expect, it } from "vitest";
import { diffLines, diffRows, diffStat } from "./line-diff";

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

describe("diffRows (side-by-side)", () => {
  it("puts unchanged lines on both sides", () => {
    const rows = diffRows(diffLines("a\nb", "a\nb"));
    expect(rows).toEqual([
      { left: { text: "a", type: "same" }, right: { text: "a", type: "same" } },
      { left: { text: "b", type: "same" }, right: { text: "b", type: "same" } },
    ]);
  });

  it("pairs a changed line (del+add) on one row", () => {
    const rows = diffRows(diffLines("a\nold\nc", "a\nnew\nc"));
    expect(rows[1]).toEqual({ left: { text: "old", type: "del" }, right: { text: "new", type: "add" } });
  });

  it("pads the side with fewer lines when adds/dels are unbalanced", () => {
    // baseline has 1 changed line, submission adds 2 -> row1 paired, row2 right-only
    const rows = diffRows(diffLines("a\nold\nc", "a\nnew1\nnew2\nc"));
    expect(rows[1]).toEqual({ left: { text: "old", type: "del" }, right: { text: "new1", type: "add" } });
    expect(rows[2]).toEqual({ left: null, right: { text: "new2", type: "add" } });
  });
});
