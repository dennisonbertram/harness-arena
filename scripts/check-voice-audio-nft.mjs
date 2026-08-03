import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NFT = resolve(ROOT, ".next/server/app/api/voice/audio/[kind]/[id]/route.js.nft.json");
export const ALLOWED_PROJECT_FILES = new Set([
  "lib/blob-access.mjs",
  "lib/blob-read.mjs",
  "lib/file-storage-lock.mjs",
]);

export function inspectVoiceAudioNft(files, { root = ROOT, nftPath = NFT } = {}) {
  const projectFiles = [];
  const forbidden = [];
  for (const entry of files) {
    const absolute = resolve(dirname(nftPath), entry);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(".next/") || rel.startsWith("node_modules/")) continue;
    projectFiles.push(rel);
    if (/^\.env(?:\.|$)/.test(rel) || /(?:secret|credential|token)/i.test(rel) || !ALLOWED_PROJECT_FILES.has(rel)) {
      forbidden.push(rel);
    }
  }
  return { projectFiles: projectFiles.sort(), forbidden: forbidden.sort() };
}

export async function checkVoiceAudioNft({ nftPath = NFT, buildStartedAtMs } = {}) {
  const metadata = await stat(nftPath);
  if (buildStartedAtMs !== undefined && metadata.mtimeMs < buildStartedAtMs) {
    throw new Error("voice audio NFT is stale and was not produced by the current build");
  }
  const parsed = JSON.parse(await readFile(nftPath, "utf8"));
  const result = inspectVoiceAudioNft(parsed.files ?? [], { nftPath });
  if (result.forbidden.length > 0) {
    throw new Error(`voice audio NFT escaped its route closure: ${JSON.stringify(result)}`);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkVoiceAudioNft();
}
