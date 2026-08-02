function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasTokenShapedField(value) {
  return isObject(value) && Object.keys(value).some((key) => /(?:token|secret|password|api[_-]?key)/i.test(key));
}

export function verifyDevelopmentEnvironment({ development, live }) {
  const missing = [];
  const violations = [];

  if (!isObject(development) || development.environment !== "development") violations.push("environment");
  if (!isObject(development) || development.branch !== "dev") violations.push("branch");
  if (!isObject(development?.vercelProject) || !development.vercelProject.id || !development.vercelProject.name) {
    missing.push("vercelProject");
  }
  if (!development?.host) missing.push("host");
  if (!development?.store?.id) missing.push("store.id");
  if (!development?.callbackOrigin) missing.push("callbackOrigin");
  if (!isObject(live) || !live.projectId) missing.push("live.projectId");
  if (!Array.isArray(live?.aliases) || live.aliases.length === 0) missing.push("live.aliases");
  if (!Array.isArray(live?.storeIds) || live.storeIds.length === 0) missing.push("live.storeIds");

  if (hasTokenShapedField(development)) {
    violations.push(...Object.keys(development).filter((key) => /(?:token|secret|password|api[_-]?key)/i.test(key)));
  }

  if (development?.vercelProject?.id && development.vercelProject.id === live?.projectId) violations.push("vercelProject.id");
  if (development?.host && live?.aliases?.includes(development.host)) violations.push("host");
  if (development?.store?.id && live?.storeIds?.includes(development.store.id)) violations.push("store.id");
  if (development?.callbackOrigin) {
    let callbackHost;
    try {
      callbackHost = new URL(development.callbackOrigin).host;
    } catch {
      violations.push("callbackOrigin");
    }
    if (callbackHost && live?.aliases?.includes(callbackHost)) violations.push("callbackOrigin");
  }

  return { ok: missing.length === 0 && violations.length === 0, missing, violations };
}

async function main() {
  const manifestPath = process.argv[2] ?? "config/development-environment.json";
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const result = verifyDevelopmentEnvironment({ development: manifest, live: manifest.live });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
