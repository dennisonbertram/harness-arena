// Parses a pi session.jsonl trace into a readable trajectory: the ordered
// steps an agent took (its reasoning, prose, and each tool call paired with the
// tool's output), plus a token/cost summary. This is the data behind the
// Trajectory tab — the transparency centerpiece — turning raw JSONL into
// something a human can actually read.
//
// Real shapes (verified from a live trace):
//   line: { type: "session"|"model_change"|"thinking_level_change"|"message", message? }
//   message.role: "user" | "assistant" | "toolResult"
//   assistant.content[]: {type:"thinking", thinking} | {type:"text", text}
//                        | {type:"toolCall", id, name, arguments}
//   assistant.usage: { input, output, cacheRead, cost:{total}, ... }
//   toolResult: { toolCallId, toolName, content:[{type:"text",text}], isError }

export type TrajBlock =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: unknown; result: { text: string; isError: boolean } | null };

export interface TrajStep {
  role: "user" | "assistant";
  blocks: TrajBlock[];
}

export interface TrajSummary {
  turns: number; // assistant messages
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  costUsd: number | null; // null when no usage carried a cost
}

export interface Trajectory {
  steps: TrajStep[];
  summary: TrajSummary;
}

/** Flattens a message `content` field (string, or array of text blocks) to text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function parseTrajectory(jsonl: string): Trajectory {
  const lines: Record<string, unknown>[] = [];
  for (const raw of jsonl.split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      lines.push(JSON.parse(s));
    } catch {
      // A malformed line never breaks the whole view.
    }
  }

  // Pair tool outputs to their calls by id.
  const resultById = new Map<string, { text: string; isError: boolean }>();
  for (const line of lines) {
    const m = line.message as Record<string, unknown> | undefined;
    if (m?.role === "toolResult" && typeof m.toolCallId === "string") {
      resultById.set(m.toolCallId, {
        text: contentText(m.content),
        isError: m.isError === true,
      });
    }
  }

  const steps: TrajStep[] = [];
  const summary: TrajSummary = { turns: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: null };

  for (const line of lines) {
    if (line.type !== "message") continue;
    const m = line.message as Record<string, unknown> | undefined;
    if (!m) continue;

    if (m.role === "user") {
      steps.push({ role: "user", blocks: [{ kind: "text", text: contentText(m.content) }] });
      continue;
    }
    if (m.role !== "assistant") continue; // toolResult rendered via resultById

    summary.turns += 1;
    const usage = m.usage as Record<string, unknown> | undefined;
    if (usage) {
      summary.tokensIn += num(usage.input);
      summary.tokensOut += num(usage.output);
      summary.cacheRead += num(usage.cacheRead);
      const cost = (usage.cost as Record<string, unknown> | undefined)?.total;
      if (typeof cost === "number" && Number.isFinite(cost)) summary.costUsd = (summary.costUsd ?? 0) + cost;
    }

    const blocks: TrajBlock[] = [];
    const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
    for (const b of content) {
      if (b.type === "thinking" && typeof b.thinking === "string") {
        blocks.push({ kind: "thinking", text: b.thinking });
      } else if (b.type === "text" && typeof b.text === "string") {
        blocks.push({ kind: "text", text: b.text });
      } else if (b.type === "toolCall") {
        const id = typeof b.id === "string" ? b.id : "";
        blocks.push({
          kind: "tool",
          name: typeof b.name === "string" ? b.name : "tool",
          args: b.arguments,
          result: resultById.get(id) ?? null,
        });
      }
    }
    if (blocks.length > 0) steps.push({ role: "assistant", blocks });
  }

  return { steps, summary };
}
