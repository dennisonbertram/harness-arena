import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const accessPolicy = require("../config/agent-access-policy.json");

export const RUNTIME_SECRET_ENVIRONMENT_NAMES = Object.freeze([
  "SYSTEM_PROMPT_B64",
  "TASKS_JSON_B64",
]);

function derivePolicySecretEnvironmentNames(policy) {
  const variables = policy?.environment_inventory?.variables;
  if (!variables || typeof variables !== "object") throw new Error("agent access policy environment inventory is unavailable");
  return Object.entries(variables)
    .filter(([, record]) => record?.secret === true)
    .map(([name]) => name)
    .sort();
}

export const POLICY_SECRET_ENVIRONMENT_NAMES = Object.freeze(derivePolicySecretEnvironmentNames(accessPolicy));
export const SECRET_ENVIRONMENT_NAMES = Object.freeze([
  ...new Set([...POLICY_SECRET_ENVIRONMENT_NAMES, ...RUNTIME_SECRET_ENVIRONMENT_NAMES]),
].sort());

const SECRET_ENVIRONMENT_NAME_SET = new Set(SECRET_ENVIRONMENT_NAMES);

export function isGovernedSecretEnvironmentName(name) {
  return SECRET_ENVIRONMENT_NAME_SET.has(name);
}

export function secretEnvironmentRedactionValues(env, additionalNames = []) {
  const names = new Set([...SECRET_ENVIRONMENT_NAMES, ...additionalNames]);
  const values = [...names]
    .map((name) => env?.[name])
    .filter((value) => typeof value === "string" && value.length > 0);
  const fingerprints = values.map((value) => createHash("sha256").update(value).digest("hex"));
  return [...new Set([...values, ...fingerprints])];
}
