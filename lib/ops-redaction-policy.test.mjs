import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isSecretEnvironmentName } from "./ops-redaction.mjs";
import { POLICY_SECRET_ENVIRONMENT_NAMES, RUNTIME_SECRET_ENVIRONMENT_NAMES } from "./secret-environment.mjs";

const RUNTIME_SECRET_HANDOFFS = ["SYSTEM_PROMPT_B64", "TASKS_JSON_B64"];

describe("secret environment policy", () => {
  it("recognizes every policy secret and runtime payload handoff", async () => {
    const policy = JSON.parse(await readFile(new URL("../config/agent-access-policy.json", import.meta.url), "utf8"));
    const policySecrets = Object.entries(policy.environment_inventory.variables)
      .filter(([, record]) => record.secret === true)
      .map(([name]) => name);
    expect(POLICY_SECRET_ENVIRONMENT_NAMES).toEqual([...policySecrets].sort());
    expect(RUNTIME_SECRET_ENVIRONMENT_NAMES).toEqual(RUNTIME_SECRET_HANDOFFS);

    const missed = [...new Set([...policySecrets, ...RUNTIME_SECRET_HANDOFFS])]
      .filter((name) => !isSecretEnvironmentName(name));
    expect(missed).toEqual([]);
  });
});
