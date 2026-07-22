// Fake callback server fixture for the runner integration test. Records
// every event batch, status/totals update, and trace upload the runner
// posts, per callback-contract.md.
import http from "node:http";

export function startCallbackServer({ secret }) {
  const state = {
    events: [],
    statusUpdates: [],
    traces: [],
    unauthorized: 0,
    seq: 0,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://127.0.0.1");

      if (req.headers["x-runner-secret"] !== secret) {
        state.unauthorized += 1;
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
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
