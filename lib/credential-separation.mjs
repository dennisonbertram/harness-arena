export const CREDENTIAL_SEPARATION_SCHEMA_VERSION = "credential_separation.v1";
export const OPS_READ_SEPARATE_FROM = Object.freeze([
  "AUTH_SECRET",
  "AUTH_GITHUB_SECRET",
  "COMPETITION_ADMIN_TOKEN",
  "RUNNER_CALLBACK_SECRET",
  "OPS_READ_CURSOR_SECRET",
  "BLOB_READ_WRITE_TOKEN",
  "VERCEL_OIDC_TOKEN",
  "AI_GATEWAY_API_KEY",
  "OPENROUTER_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "VERCEL_TOKEN",
]);

function constantTimeEqual(left, right) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export function credentialSeparationAttestation(env = process.env) {
  const opsToken = env.OPS_READ_TOKEN;
  let checkedCount = 0;
  let invalid = false;
  if (typeof opsToken === "string" && opsToken.length > 0) {
    for (const name of OPS_READ_SEPARATE_FROM) {
      const value = env[name];
      if (typeof value !== "string" || value.length === 0) continue;
      checkedCount += 1;
      if (constantTimeEqual(opsToken, value)) invalid = true;
    }
  }
  return Object.freeze({
    schema_version: CREDENTIAL_SEPARATION_SCHEMA_VERSION,
    state: invalid ? "invalid" : "ok",
    checked_count: checkedCount,
    policy_size: OPS_READ_SEPARATE_FROM.length,
  });
}

export function assertOpsReadCredentialSeparation(env = process.env) {
  if (credentialSeparationAttestation(env).state !== "ok") throw new Error("credential_separation_invalid");
}

export function separatedCredential(name, env = process.env) {
  if (!OPS_READ_SEPARATE_FROM.includes(name)) throw new Error("credential_not_in_separation_policy");
  assertOpsReadCredentialSeparation(env);
  return env[name];
}
