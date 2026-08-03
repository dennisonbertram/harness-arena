import developmentEnvironment from "@/config/development-environment.json";
import type { AgentIdentity } from "./agent-token";

type EnvironmentManifest = typeof developmentEnvironment;
type Environment = Record<string, string | undefined>;

export const SEEDED_DEVELOPMENT_IDENTITY: AgentIdentity = Object.freeze({
  githubId: -144,
  githubLogin: "harness-local-development",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isDeterministicMode(value: string | undefined): boolean {
  return value?.startsWith("deterministic-") === true;
}

function hasVercelRuntime(env: Environment): boolean {
  return Boolean(env.VERCEL || env.VERCEL_ENV || env.VERCEL_URL || env.VERCEL_REGION || env.VERCEL_PROJECT_ID);
}

export function assertDeterministicLocalEnvironment(env: Environment = process.env): void {
  if (
    env.NODE_ENV !== "development"
    || env.HARNESS_LOCAL_INIT !== "1"
    || env.STORAGE !== "file"
    || !isDeterministicMode(env.HARNESS_EXECUTION_MODE)
    || !env.HARNESS_GIT_BRANCH
    || env.HARNESS_GIT_BRANCH === "main"
    || hasVercelRuntime(env)
  ) {
    throw new Error("deterministic execution is restricted to verified non-main local development");
  }
}

function localIdentityAllowed(request: Request, env: Environment): boolean {
  try {
    assertDeterministicLocalEnvironment(env);
    return LOOPBACK_HOSTS.has(new URL(request.url).hostname);
  } catch {
    return false;
  }
}

function hostedDevelopmentIdentityAllowed(
  request: Request,
  env: Environment,
  manifest: EnvironmentManifest,
): boolean {
  const host = manifest.host;
  const storeId = manifest.store.id;
  const callbackOrigin = manifest.callbackOrigin;
  if (!host || !storeId || !callbackOrigin) return false;
  let callback: URL;
  try { callback = new URL(callbackOrigin); } catch { return false; }
  const requestHost = new URL(request.url).hostname;
  return env.VERCEL === "1"
    && env.HARNESS_LOCAL_INIT !== "1"
    && env.VERCEL_PROJECT_ID === manifest.vercelProject.id
    && env.VERCEL_PROJECT_ID !== manifest.live.projectId
    && env.VERCEL_GIT_COMMIT_REF === manifest.branch
    && env.VERCEL_GIT_COMMIT_REF !== "main"
    && env.STORAGE !== "file"
    && Boolean(env.BLOB_READ_WRITE_TOKEN)
    && env.HARNESS_BLOB_STORE_ID === storeId
    && !manifest.live.storeIds.includes(storeId)
    && env.CALLBACK_BASE === callbackOrigin
    && callback.protocol === "https:"
    && callback.origin === callbackOrigin
    && callback.hostname === host
    && requestHost === host
    && !manifest.live.aliases.includes(requestHost)
    && !manifest.live.aliases.includes(callback.hostname);
}

export function resolveSeededDevelopmentIdentity(
  request: Request,
  env: Environment = process.env,
  manifest: EnvironmentManifest = developmentEnvironment,
): AgentIdentity | null {
  if (env.HARNESS_DEVELOPMENT_IDENTITY !== "seeded") return null;
  if (localIdentityAllowed(request, env) || hostedDevelopmentIdentityAllowed(request, env, manifest)) {
    return SEEDED_DEVELOPMENT_IDENTITY;
  }
  return null;
}
