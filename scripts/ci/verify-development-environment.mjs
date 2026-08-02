import { readFile } from "node:fs/promises";
import { domainToASCII, pathToFileURL } from "node:url";

const CREDENTIAL_KEY = /(?:token|secret|password|credential|api[_-]?key)/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function addOnce(items, value) {
  if (!items.includes(value)) items.push(value);
}

function credentialKeyPaths(value, prefix = "", seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const paths = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => paths.push(...credentialKeyPaths(item, `${prefix}[${index}]`, seen)));
    return paths;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (CREDENTIAL_KEY.test(key)) paths.push(path);
    paths.push(...credentialKeyPaths(child, path, seen));
  }
  return paths;
}

function requiredString(value, path, missing, violations) {
  if (value === null || value === undefined || value === "") {
    addOnce(missing, path);
    return null;
  }
  if (typeof value !== "string") {
    addOnce(violations, path);
    return null;
  }
  const normalized = value.trim();
  if (!normalized) {
    addOnce(missing, path);
    return null;
  }
  return normalized;
}

function normalizeIdentity(value) {
  return value.trim().toLowerCase();
}

function normalizeHostname(value) {
  const withoutTrailingDot = value.trim().replace(/\.$/, "");
  const ascii = domainToASCII(withoutTrailingDot).toLowerCase();
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }
  return ascii;
}

function hostname(value, path, missing, violations) {
  const stringValue = requiredString(value, path, missing, violations);
  if (stringValue === null) return null;
  const normalized = normalizeHostname(stringValue);
  if (!normalized) addOnce(violations, path);
  return normalized;
}

function normalizedArray(value, path, normalizer, missing, violations) {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    addOnce(missing, path);
    return [];
  }
  if (!Array.isArray(value)) {
    addOnce(violations, path);
    return [];
  }

  return value.flatMap((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      addOnce(violations, `${path}[${index}]`);
      return [];
    }
    const normalized = normalizer(item);
    if (!normalized) {
      addOnce(violations, `${path}[${index}]`);
      return [];
    }
    return [normalized];
  });
}

function callbackHostname(value, developmentHost, missing, violations) {
  const stringValue = requiredString(value, "callbackOrigin", missing, violations);
  if (stringValue === null) return null;

  let parsed;
  try {
    parsed = new URL(stringValue);
  } catch {
    addOnce(violations, "callbackOrigin");
    return null;
  }

  const normalizedHost = normalizeHostname(parsed.hostname);
  const canonical =
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.port === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    normalizedHost !== null;

  if (!canonical || (developmentHost !== null && normalizedHost !== developmentHost)) {
    addOnce(violations, "callbackOrigin");
  }
  return normalizedHost;
}

export function verifyDevelopmentEnvironment({ development, live }) {
  const missing = [];
  const violations = [];

  for (const path of credentialKeyPaths(development)) addOnce(violations, path);
  for (const path of credentialKeyPaths(live, "live")) addOnce(violations, path);

  if (!isObject(development)) {
    addOnce(violations, "development");
    return { ok: false, missing, violations };
  }
  if (!isObject(live)) {
    addOnce(violations, "live");
    return { ok: false, missing, violations };
  }

  const environment = requiredString(development.environment, "environment", missing, violations);
  if (environment !== null && environment !== "development") addOnce(violations, "environment");
  const branch = requiredString(development.branch, "branch", missing, violations);
  if (branch !== null && branch !== "dev") addOnce(violations, "branch");

  let developmentProjectId = null;
  if (!isObject(development.vercelProject)) {
    if (development.vercelProject === null || development.vercelProject === undefined) {
      addOnce(missing, "vercelProject");
    } else {
      addOnce(violations, "vercelProject");
    }
  } else {
    const projectId = requiredString(development.vercelProject.id, "vercelProject.id", missing, violations);
    developmentProjectId = projectId === null ? null : normalizeIdentity(projectId);
    requiredString(development.vercelProject.name, "vercelProject.name", missing, violations);
  }

  const developmentHost = hostname(development.host, "host", missing, violations);

  let developmentStoreId = null;
  if (!isObject(development.store)) {
    if (development.store === null || development.store === undefined) addOnce(missing, "store");
    else addOnce(violations, "store");
  } else {
    const storeId = requiredString(development.store.id, "store.id", missing, violations);
    developmentStoreId = storeId === null ? null : normalizeIdentity(storeId);
  }

  const callbackHost = callbackHostname(development.callbackOrigin, developmentHost, missing, violations);
  const liveProjectIdValue = requiredString(live.projectId, "live.projectId", missing, violations);
  const liveProjectId = liveProjectIdValue === null ? null : normalizeIdentity(liveProjectIdValue);
  const liveAliases = normalizedArray(live.aliases, "live.aliases", normalizeHostname, missing, violations);
  const liveStoreIds = normalizedArray(live.storeIds, "live.storeIds", normalizeIdentity, missing, violations);

  if (developmentProjectId && liveProjectId && developmentProjectId === liveProjectId) {
    addOnce(violations, "vercelProject.id");
  }
  if (developmentHost && liveAliases.includes(developmentHost)) addOnce(violations, "host");
  if (developmentStoreId && liveStoreIds.includes(developmentStoreId)) addOnce(violations, "store.id");
  if (callbackHost && liveAliases.includes(callbackHost)) addOnce(violations, "callbackOrigin");

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
