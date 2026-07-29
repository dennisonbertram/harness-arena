// Fake callback server fixture for the runner integration test. Records
// every event batch, status/totals update, and trace upload the runner
// posts, per callback-contract.md. It can also serve the authenticated grading
// payload that production exposes at GET /api/runner-tests.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

function collectTestFiles(testsDir, prefix = "", out = {}) {
  for (const entry of readdirSync(testsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const source = path.join(testsDir, entry.name);
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(source, relative, out);
      continue;
    }
    if (!entry.isFile()) continue;

    if (entry.name.endsWith(".b64")) {
      const decodedName = relative.slice(0, -".b64".length);
      out[decodedName] = Buffer.from(readFileSync(source, "utf8"), "base64").toString("base64");
    } else {
      out[relative] = readFileSync(source).toString("base64");
    }
  }
  return out;
}

function collectTests(tasksRoot) {
  const tests = {};
  for (const task of readdirSync(tasksRoot, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!task.isDirectory()) continue;
    const testsDir = path.join(tasksRoot, task.name, "tests");
    if (!existsSync(testsDir)) continue;
    tests[task.name] = collectTestFiles(testsDir);
  }
  return tests;
}

export function startCallbackServer({ secret, tasksRoot = null }) {
  const state = {
    events: [],
    statusUpdates: [],
    traces: [],
    testFetches: 0,
    unauthorized: 0,
    seq: 0,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");

      // Test-only AI Gateway upstream for the runner's startup preflight. The
      // integration test replaces pi itself, so only a successful response is
      // needed to prove the sidecar path is alive without spending a real API
      // call or depending on external credentials.
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [] }));
        return;
      }

      if (req.headers["x-runner-secret"] !== secret) {
        state.unauthorized += 1;
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }

      if (req.method === "GET" && url.pathname.endsWith("/api/runner-tests")) {
        state.testFetches += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ tests: tasksRoot ? collectTests(tasksRoot) : {} }));
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/callback")) {
        let parsed;
        try {
          parsed = body.length ? JSON.parse(body.toString("utf8")) : {};
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid json" }));
          return;
        }
        const events = Array.isArray(parsed.events) ? parsed.events : [];
        const seqAssigned = events.map(() => ++state.seq);
        events.forEach((event, i) => state.events.push({ ...event, seq: seqAssigned[i] }));
        if (parsed.status || parsed.totals || parsed.task_results) {
          state.statusUpdates.push({
            status: parsed.status,
            totals: parsed.totals,
            task_results: parsed.task_results,
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, seq_assigned: seqAssigned }));
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/trace")) {
        const taskId = url.searchParams.get("task_id");
        const name = url.searchParams.get("name");
        const blobUrl = `fake://blob/${taskId}/${name}`;
        state.traces.push({ taskId, name, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, url: blobUrl }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        state,
        baseUrl: `http://127.0.0.1:${address.port}`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
