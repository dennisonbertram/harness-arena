import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Sandbox } from "@vercel/sandbox";
import { runRealSandboxSmoke } from "./real-sandbox-smoke-lib.mjs";

export async function main() {
  const result = await runRealSandboxSmoke({ create: (options) => Sandbox.create(options) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
