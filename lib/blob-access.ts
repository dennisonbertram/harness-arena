import type { BlobAccessType } from "@vercel/blob";

type Environment = Record<string, string | undefined>;

// The isolated project is deliberately identified by immutable project ID, not
// VERCEL_ENV: its protected dev branch is Vercel's Production deployment.
export const DEVELOPMENT_PROJECT_ID = "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA";

export function resolveBlobAccess(env: Environment = process.env): { access: BlobAccessType } {
  const configured = env.BLOB_ACCESS;
  if (configured !== undefined && configured !== "public" && configured !== "private") {
    throw new Error("storage misconfigured: BLOB_ACCESS must be public or private");
  }

  const isolatedDevelopment = env.VERCEL_PROJECT_ID === DEVELOPMENT_PROJECT_ID;
  if (isolatedDevelopment && configured === "public") {
    throw new Error("storage misconfigured: Development Blob access must be private");
  }

  // The development store must be explicit/private even though its Vercel
  // deployment environment is labelled Production. Live keeps its established
  // public default until its separately-owned configuration is migrated.
  return { access: configured ?? (isolatedDevelopment ? "private" : "public") };
}

export const blobAccess = () => resolveBlobAccess().access;
