import type { BlobAccessType } from "@vercel/blob";
import { DEVELOPMENT_PROJECT_ID, resolveBlobAccess as resolve, blobAccess as access, blobCommandOptions as options, probeBlobAccess as probe } from "./blob-access.mjs";
export { DEVELOPMENT_PROJECT_ID };
export const resolveBlobAccess = (env: Record<string, string | undefined> = process.env): { access: BlobAccessType } => resolve(env as NodeJS.ProcessEnv) as { access: BlobAccessType };
export const blobAccess = (): BlobAccessType => access(process.env) as BlobAccessType;
export const blobCommandOptions = <T extends Record<string, unknown>>(extra: T = {} as T): T & ({ access: BlobAccessType; token: string } | { access: BlobAccessType; oidcToken: string; storeId: string }) =>
  options(extra, process.env) as T & ({ access: BlobAccessType; token: string } | { access: BlobAccessType; oidcToken: string; storeId: string });

/** Authenticates the exact selected credential/store without enumerating data. */
export async function probeBlobAccess(): Promise<void> {
  await probe(process.env);
}
