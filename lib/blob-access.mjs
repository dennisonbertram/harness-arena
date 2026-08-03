import { list } from "@vercel/blob";

export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
const OIDC_MIN_TTL_SECONDS = 60;
const normalizeStoreId = (value) => value?.startsWith("store_") ? value.slice("store_".length) : value;

function readWriteTokenStoreId(token) {
  if (typeof token !== "string") return undefined;
  return /^vercel_blob_rw_([^_]+)_/.exec(token)?.[1];
}

// This is only a fail-fast structural/expiry preflight. JWT claims are
// untrusted until the Blob API authenticates the token in probeBlobAccess or
// the requested SDK operation.
function preflightOidcClaims(token, env, nowSeconds) {
  const parts = token?.split(".");
  if (parts?.length !== 3 || parts.some((part) => !part)) throw new Error("storage misconfigured: OIDC token is malformed");
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); }
  catch { throw new Error("storage misconfigured: OIDC token is malformed"); }
  if (!Number.isSafeInteger(payload?.exp) || payload.exp <= nowSeconds + OIDC_MIN_TTL_SECONDS) {
    throw new Error("storage misconfigured: OIDC token is expired or cannot cover the request window");
  }
  if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds)) {
    throw new Error("storage misconfigured: OIDC token is not active");
  }
  if (env.VERCEL_PROJECT_ID && payload.project_id !== env.VERCEL_PROJECT_ID) {
    throw new Error("storage misconfigured: OIDC project identity mismatch");
  }
}

function accessFor(env) {
  const configured = env.BLOB_ACCESS;
  if (configured !== undefined && configured !== "public" && configured !== "private") throw new Error("storage misconfigured: BLOB_ACCESS must be public or private");
  const development = env.VERCEL_PROJECT_ID === DEVELOPMENT_PROJECT_ID;
  if (development && configured === "public") throw new Error("storage misconfigured: Development Blob access must be private");
  return { access: configured ?? (development ? "private" : "public"), development };
}

export function resolveBlobCommandOptions(env = process.env, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const { access, development } = accessFor(env);
  const harnessStore = normalizeStoreId(env.HARNESS_BLOB_STORE_ID);
  const configuredStore = normalizeStoreId(env.BLOB_STORE_ID);
  if (development) {
    if (!harnessStore) throw new Error("storage misconfigured: Development Blob store identity is required");
    if (!configuredStore) throw new Error("storage misconfigured: Development BLOB_STORE_ID is required");
    if (configuredStore !== harnessStore) throw new Error("storage misconfigured: Blob store identity mismatch");
  }

  const readWriteToken = env.BLOB_READ_WRITE_TOKEN?.trim();
  const readWriteStore = readWriteTokenStoreId(readWriteToken);
  if (readWriteToken && !readWriteStore) throw new Error("storage misconfigured: Blob credential store identity unavailable");
  const expectedStore = development ? harnessStore : configuredStore;
  if (readWriteStore && expectedStore && normalizeStoreId(readWriteStore) !== expectedStore) {
    throw new Error("storage misconfigured: Blob credential store identity mismatch");
  }

  const oidcToken = env.VERCEL_OIDC_TOKEN?.trim();
  if (oidcToken) {
    if (!configuredStore) throw new Error("storage misconfigured: BLOB_STORE_ID is required for OIDC");
    preflightOidcClaims(oidcToken, env, nowSeconds);
    if (readWriteToken && normalizeStoreId(readWriteStore) !== configuredStore) {
      throw new Error("storage misconfigured: Blob credential store identity mismatch");
    }
    return { access, oidcToken, storeId: env.BLOB_STORE_ID };
  }
  if (readWriteToken) return { access, token: readWriteToken };
  throw new Error("storage misconfigured: no explicit Blob credential is configured");
}

export function resolveBlobAccess(env = process.env) {
  const { access, development } = accessFor(env);
  if (development) resolveBlobCommandOptions(env);
  return { access };
}

export function blobCommandOptions(extra = {}, env = process.env) {
  const safeExtra = { ...extra };
  delete safeExtra.token;
  delete safeExtra.oidcToken;
  delete safeExtra.storeId;
  delete safeExtra.access;
  const resolved = resolveBlobCommandOptions(env);
  const options = { ...safeExtra, access: resolved.access };
  for (const key of ["token", "oidcToken", "storeId"]) {
    if (resolved[key] !== undefined) {
      Object.defineProperty(options, key, { value: resolved[key], enumerable: false });
    }
  }
  return options;
}

/** Authenticates the exact selected credential/store without enumerating data. */
export async function probeBlobAccess(env = process.env) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Blob credential probe timed out"));
    }, 3_000);
  });
  try {
    await Promise.race([
      list(blobCommandOptions({ limit: 1, abortSignal: controller.signal }, env)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export const blobAccess = (env = process.env) => resolveBlobAccess(env).access;
