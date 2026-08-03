export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
const normalizeStoreId = (value) => value?.startsWith("store_") ? value.slice("store_".length) : value;
function readWriteTokenStoreId(token) {
  if (typeof token !== "string") return undefined;
  const match = /^vercel_blob_rw_([^_]+)_/.exec(token);
  return match?.[1];
}
export function resolveBlobAccess(env = process.env) {
  const configured = env.BLOB_ACCESS;
  if (configured !== undefined && configured !== "public" && configured !== "private") throw new Error("storage misconfigured: BLOB_ACCESS must be public or private");
  const development = env.VERCEL_PROJECT_ID === DEVELOPMENT_PROJECT_ID;
  if (development && configured === "public") throw new Error("storage misconfigured: Development Blob access must be private");
  if (development) {
    if (!env.HARNESS_BLOB_STORE_ID) throw new Error("storage misconfigured: Development Blob store identity is required");
    if (!env.BLOB_STORE_ID) throw new Error("storage misconfigured: Development BLOB_STORE_ID is required");
    const expected = normalizeStoreId(env.HARNESS_BLOB_STORE_ID);
    if (normalizeStoreId(env.BLOB_STORE_ID) !== expected) throw new Error("storage misconfigured: Blob store identity mismatch");
    // @vercel/blob resolves an ambient OIDC credential with BLOB_STORE_ID
    // before its ambient read-write token. Otherwise its supported token
    // format carries the active store id in the credential itself.
    if (!env.VERCEL_OIDC_TOKEN) {
      const credentialStore = readWriteTokenStoreId(env.BLOB_READ_WRITE_TOKEN);
      if (!credentialStore) throw new Error("storage misconfigured: Blob credential store identity unavailable");
      if (normalizeStoreId(credentialStore) !== expected) throw new Error("storage misconfigured: Blob credential store identity mismatch");
    }
  }
  return { access: configured ?? (development ? "private" : "public") };
}
export const blobAccess = (env = process.env) => resolveBlobAccess(env).access;
