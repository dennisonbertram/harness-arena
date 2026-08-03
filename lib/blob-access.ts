import type { BlobAccessType } from "@vercel/blob";
import { DEVELOPMENT_PROJECT_ID, resolveBlobAccess as resolve, blobAccess as access } from "./blob-access.mjs";
export { DEVELOPMENT_PROJECT_ID };
export const resolveBlobAccess = (env: Record<string, string | undefined> = process.env): { access: BlobAccessType } => resolve(env as NodeJS.ProcessEnv) as { access: BlobAccessType };
export const blobAccess = (): BlobAccessType => access(process.env) as BlobAccessType;
