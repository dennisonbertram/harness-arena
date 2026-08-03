export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";
export function resolveBlobAccess(env = process.env) {
  const configured = env.BLOB_ACCESS;
  if (configured !== undefined && configured !== "public" && configured !== "private") throw new Error("storage misconfigured: BLOB_ACCESS must be public or private");
  const development = env.VERCEL_PROJECT_ID === DEVELOPMENT_PROJECT_ID;
  if (development && configured === "public") throw new Error("storage misconfigured: Development Blob access must be private");
  if (development) {
    if (!env.HARNESS_BLOB_STORE_ID) throw new Error("storage misconfigured: Development Blob store identity is required");
    if (env.BLOB_STORE_ID && env.BLOB_STORE_ID !== env.HARNESS_BLOB_STORE_ID) throw new Error("storage misconfigured: Blob store identity mismatch");
  }
  return { access: configured ?? (development ? "private" : "public") };
}
export const blobAccess = (env = process.env) => resolveBlobAccess(env).access;
