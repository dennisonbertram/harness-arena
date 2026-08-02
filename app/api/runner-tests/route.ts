import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { verifyRunnerSecret } from "@/lib/runner-auth";
import { getTasks } from "@/lib/tasks";

// Grading materials (tests/test.sh, test_outputs.py, fixtures) for every task,
// delivered ONLY to the in-sandbox runner, which authenticates with
// RUNNER_CALLBACK_SECRET. These MUST NOT be served publicly: a submitted
// harness that could read the exact assertions it's graded against would
// trivially reward-hack. This route replaces the old, unauthenticated
// public/runner-bundle.tgz tests payload -- the public bundle now carries
// runner code only. The agent's task container never receives the secret
// (runner.mjs forwards only the two model API keys into `docker exec`), so it
// cannot reach this route; only the outer runner process can.
export const dynamic = "force-dynamic";

// Files whose raw bytes trip GitHub secret-scanning push protection are stored
// base64-encoded as `<name>.b64` (e.g. sanitize-git-repo's fake leaked
// tokens). Decode them back to their real name so the runtime file the
// verifier sees is byte-identical to upstream before transport.
function realNameAndBytes(filePath: string): { name: string; bytes: Buffer } {
  const raw = readFileSync(filePath);
  if (filePath.endsWith(".b64")) {
    return {
      name: path.basename(filePath).slice(0, -".b64".length),
      bytes: Buffer.from(raw.toString("utf8"), "base64"),
    };
  }
  return { name: path.basename(filePath), bytes: raw };
}

// Walk a task's tests/ dir and return { <relPath>: <base64 bytes> }. base64
// transport keeps binary fixtures (json/ttl/sql/txt) intact through JSON.
function collectTaskTests(testsDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, path.join(prefix, entry.name));
      } else {
        const { name, bytes } = realNameAndBytes(full);
        out[path.join(prefix, name)] = bytes.toString("base64");
      }
    }
  };
  walk(testsDir, "");
  return out;
}

export async function GET(request: NextRequest) {
  if (!verifyRunnerSecret(request)) {
    return new NextResponse(null, { status: 401 });
  }
  const tests: Record<string, Record<string, string>> = {};
  for (const task of getTasks()) {
    tests[task.id] = collectTaskTests(task.testsDir);
  }
  return NextResponse.json({ tests });
}
