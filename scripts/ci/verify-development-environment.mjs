import { readFile } from "node:fs/promises";
import { domainToASCII, pathToFileURL } from "node:url";

const CREDENTIAL_KEY = /(?:token|secret|password|credential|api[_-]?key)/i;
const VERCEL_ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]*$/;
const DEVELOPMENT_KEYS = new Set([
  "environment",
  "branch",
  "git",
  "vercelProject",
  "host",
  "store",
  "callbackOrigin",
  "hostedAcceptance",
  "live",
]);
const VERCEL_PROJECT_KEYS = new Set(["id", "name"]);
const GIT_KEYS = new Set(["provider", "repository", "productionBranch"]);
const STORE_KEYS = new Set(["id"]);
const LIVE_KEYS = new Set(["projectId", "aliases", "storeIds"]);
export const HOSTED_ACCEPTANCE_CONTRACT = Object.freeze({
  runsPerSubmission: Object.freeze({
    expected: 1,
    runtime: Object.freeze({ kind: "vercel-environment", key: "RUNS_PER_SUBMISSION" }),
  }),
  maxConcurrentRuns: Object.freeze({
    expected: 1,
    runtime: Object.freeze({ kind: "vercel-environment", key: "MAX_CONCURRENT_RUNS" }),
  }),
  maxStartsPerTick: Object.freeze({
    expected: 1,
    runtime: Object.freeze({ kind: "vercel-environment", key: "MAX_STARTS_PER_TICK" }),
  }),
  runBudgetCapUsd: Object.freeze({
    expected: 0.25,
    runtime: Object.freeze({ kind: "vercel-environment", key: "RUN_BUDGET_CAP_USD" }),
  }),
  runnerAgentTimeoutCapSeconds: Object.freeze({
    expected: 30,
    runtime: Object.freeze({ kind: "vercel-environment", key: "RUNNER_AGENT_TIMEOUT_CAP" }),
  }),
  runnerVerifyTimeoutCapSeconds: Object.freeze({
    expected: 30,
    runtime: Object.freeze({ kind: "vercel-environment", key: "RUNNER_VERIFY_TIMEOUT_CAP" }),
  }),
  runnerSandboxTimeoutMinutes: Object.freeze({
    expected: 60,
    runtime: Object.freeze({ kind: "vercel-environment", key: "RUNNER_SANDBOX_TIMEOUT_MIN" }),
  }),
  gatewayProjectBudgetUsd: Object.freeze({
    expected: 1,
    runtime: Object.freeze({ kind: "gateway-project-budget" }),
  }),
});

export function classifyHostedAcceptanceContract(contract) {
  if (contract === null || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("invalid hosted acceptance contract");
  }

  const environment = new Map();
  let gatewayProjectBudgetAcceptanceKey;
  for (const [acceptanceKey, descriptor] of Object.entries(contract)) {
    if (
      descriptor === null
      || typeof descriptor !== "object"
      || Array.isArray(descriptor)
      || typeof descriptor.expected !== "number"
      || !Number.isFinite(descriptor.expected)
      || descriptor.runtime === null
      || typeof descriptor.runtime !== "object"
      || Array.isArray(descriptor.runtime)
      || typeof descriptor.runtime.kind !== "string"
    ) {
      throw new Error("invalid hosted acceptance runtime descriptor");
    }

    if (descriptor.runtime.kind === "vercel-environment") {
      if (
        Object.keys(descriptor.runtime).length !== 2
        || typeof descriptor.runtime.key !== "string"
        || !descriptor.runtime.key
        || !VERCEL_ENVIRONMENT_KEY.test(descriptor.runtime.key)
        || environment.has(descriptor.runtime.key)
      ) {
        throw new Error("invalid hosted acceptance runtime descriptor");
      }
      environment.set(descriptor.runtime.key, acceptanceKey);
      continue;
    }

    if (descriptor.runtime.kind === "gateway-project-budget") {
      if (
        Object.keys(descriptor.runtime).length !== 1
        || gatewayProjectBudgetAcceptanceKey !== undefined
      ) {
        throw new Error("invalid hosted acceptance runtime descriptor");
      }
      gatewayProjectBudgetAcceptanceKey = acceptanceKey;
      continue;
    }

    throw new Error(`unhandled hosted acceptance runtime kind: ${descriptor.runtime.kind}`);
  }

  if (gatewayProjectBudgetAcceptanceKey === undefined) {
    throw new Error("missing hosted acceptance gateway-project-budget descriptor");
  }
  return Object.freeze({
    environment: Object.freeze(Object.fromEntries(environment)),
    gatewayProjectBudgetAcceptanceKey,
  });
}

export const HOSTED_ACCEPTANCE_RUNTIME = classifyHostedAcceptanceContract(HOSTED_ACCEPTANCE_CONTRACT);
const HOSTED_ACCEPTANCE_KEYS = new Set(Object.keys(HOSTED_ACCEPTANCE_CONTRACT));
const REQUIRED_HOSTED_ACCEPTANCE = Object.freeze(Object.fromEntries(
  Object.entries(HOSTED_ACCEPTANCE_CONTRACT).map(([key, { expected }]) => [key, expected]),
));

const KNOWN_LIVE_PROJECT_ID = "prj_f4ppu0xpO0LZeHOAH99RHotVbwyo";
const KNOWN_LIVE_ALIASES = [
  "harness-arena-psi.vercel.app",
  "harness-arena-dennisons-projects.vercel.app",
  "harness-arena-git-main-dennisons-projects.vercel.app",
];
const KNOWN_LIVE_STORE_IDS = ["store_SgaF1fm7nkPQPCKq"];

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

function unknownKeyPaths(value, allowedKeys, prefix = "") {
  if (!isObject(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .map((key) => (prefix ? `${prefix}.${key}` : key));
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

function requiredExactNumber(value, path, expected, missing, violations) {
  if (value === null || value === undefined) {
    addOnce(missing, path);
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value !== expected) {
    addOnce(violations, path);
  }
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

  for (const path of unknownKeyPaths(development, DEVELOPMENT_KEYS)) addOnce(violations, path);
  for (const path of unknownKeyPaths(development.vercelProject, VERCEL_PROJECT_KEYS, "vercelProject")) {
    addOnce(violations, path);
  }
  for (const path of unknownKeyPaths(development.git, GIT_KEYS, "git")) addOnce(violations, path);
  for (const path of unknownKeyPaths(development.store, STORE_KEYS, "store")) addOnce(violations, path);
  for (const path of unknownKeyPaths(development.hostedAcceptance, HOSTED_ACCEPTANCE_KEYS, "hostedAcceptance")) {
    addOnce(violations, path);
  }
  for (const path of unknownKeyPaths(live, LIVE_KEYS, "live")) addOnce(violations, path);
  if (Object.hasOwn(development, "live")) {
    if (!isObject(development.live)) addOnce(violations, "live");
    for (const path of unknownKeyPaths(development.live, LIVE_KEYS, "live")) addOnce(violations, path);
  }

  const environment = requiredString(development.environment, "environment", missing, violations);
  if (environment !== null && environment !== "development") addOnce(violations, "environment");
  const branch = requiredString(development.branch, "branch", missing, violations);
  if (branch !== null && branch !== "dev") addOnce(violations, "branch");

  if (!isObject(development.git)) {
    if (development.git === null || development.git === undefined) addOnce(missing, "git");
    else addOnce(violations, "git");
  } else {
    const provider = requiredString(development.git.provider, "git.provider", missing, violations);
    const repository = requiredString(development.git.repository, "git.repository", missing, violations);
    const productionBranch = requiredString(
      development.git.productionBranch,
      "git.productionBranch",
      missing,
      violations,
    );
    if (provider !== null && provider !== "github") addOnce(violations, "git.provider");
    if (repository !== null && repository !== "dennisonbertram/harness-arena") addOnce(violations, "git.repository");
    if (productionBranch !== null && productionBranch !== "dev") addOnce(violations, "git.productionBranch");
  }

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
  if (!isObject(development.hostedAcceptance)) {
    if (development.hostedAcceptance === null || development.hostedAcceptance === undefined) {
      addOnce(missing, "hostedAcceptance");
    } else {
      addOnce(violations, "hostedAcceptance");
    }
  } else {
    for (const [key, expected] of Object.entries(REQUIRED_HOSTED_ACCEPTANCE)) {
      requiredExactNumber(development.hostedAcceptance[key], `hostedAcceptance.${key}`, expected, missing, violations);
    }
  }
  const liveProjectIdValue = requiredString(live.projectId, "live.projectId", missing, violations);
  const liveProjectId = liveProjectIdValue === null ? null : normalizeIdentity(liveProjectIdValue);
  const liveAliases = normalizedArray(live.aliases, "live.aliases", normalizeHostname, missing, violations);
  const liveStoreIds = normalizedArray(live.storeIds, "live.storeIds", normalizeIdentity, missing, violations);

  const knownProjectId = normalizeIdentity(KNOWN_LIVE_PROJECT_ID);
  const knownAliases = KNOWN_LIVE_ALIASES.map(normalizeHostname);
  const knownStoreIds = KNOWN_LIVE_STORE_IDS.map(normalizeIdentity);
  if (liveProjectId && liveProjectId !== knownProjectId) addOnce(violations, "live.projectId");
  if (knownAliases.some((alias) => !liveAliases.includes(alias))) addOnce(violations, "live.aliases");
  if (knownStoreIds.some((storeId) => !liveStoreIds.includes(storeId))) addOnce(violations, "live.storeIds");

  const protectedAliases = new Set([...liveAliases, ...knownAliases]);
  const protectedStoreIds = new Set([...liveStoreIds, ...knownStoreIds]);

  if (developmentProjectId && (developmentProjectId === liveProjectId || developmentProjectId === knownProjectId)) {
    addOnce(violations, "vercelProject.id");
  }
  if (developmentHost && protectedAliases.has(developmentHost)) addOnce(violations, "host");
  if (developmentStoreId && protectedStoreIds.has(developmentStoreId)) addOnce(violations, "store.id");
  if (callbackHost && protectedAliases.has(callbackHost)) addOnce(violations, "callbackOrigin");

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
