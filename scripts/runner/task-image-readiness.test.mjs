import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const RUNNER = new URL("./runner.mjs", import.meta.url);
let fixtureRoot;

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

describe("task image readiness process gate", () => {
  it("stops a failed immutable acquisition before gateway or Pi/task work", async () => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "runner-image-ready-"));
    const dockerLog = path.join(fixtureRoot, "docker.log");
    const fakeDocker = path.join(fixtureRoot, "docker.sh");
    writeFileSync(fakeDocker, [
      "#!/usr/bin/env sh",
      "printf '%s\\n' \"$*\" >> \"$DOCKER_LOG\"",
      "if [ \"$1\" = info ]; then exit 0; fi",
      "if [ \"$1\" = image ]; then printf '%s' '{\"Id\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"RepoDigests\":[]}'; exit 0; fi",
      "if [ \"$1\" = pull ]; then exit 17; fi",
      "exit 91",
    ].join("\n"));
    chmodSync(fakeDocker, 0o755);

    const task = {
      id: "image-readiness-fixture",
      image: "example.invalid/image-readiness:20251031",
      instruction: "must never reach pi",
      agent_timeout_sec: 1,
      verifier_timeout_sec: 1,
    };
    const lock = {
      version: 1,
      images: [{
        task_id: task.id,
        lookup_ref: task.image,
        manifest_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        config_digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      }],
    };
    const env = {
      ...process.env,
      RUN_ID: "image-readiness-fixture",
      CALLBACK_BASE: "http://127.0.0.1:1",
      RUNNER_CALLBACK_SECRET: "fixture-secret",
      AI_GATEWAY_API_KEY: "fixture-gateway-key",
      DOCKER_CMD: fakeDocker,
      DOCKER_LOG: dockerLog,
      GATEWAY_PROXY_PORT: "14677",
      RUNNER_HTTP_TIMEOUT_MS: "25",
      TASKS_JSON_B64: Buffer.from(JSON.stringify([task]), "utf8").toString("base64"),
      TASK_IMAGE_LOCK_B64: Buffer.from(JSON.stringify(lock), "utf8").toString("base64"),
      SYSTEM_PROMPT_B64: Buffer.from("fixture", "utf8").toString("base64"),
    };

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [RUNNER.pathname], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("task_image_acquire_failed task_id=image-readiness-fixture exit_code=17");
    expect(result.stdout).not.toContain("gateway proxy listening");
    expect(result.stdout).not.toContain("gateway preflight");
    const dockerCommands = readFileSync(dockerLog, "utf8");
    expect(dockerCommands).toContain("image inspect");
    expect(dockerCommands).toContain("pull example.invalid/image-readiness@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(dockerCommands).not.toMatch(/^(?:run|exec)\b/m);
  }, 15_000);
});
