import { readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NFT = resolve(ROOT, ".next/server/app/api/voice/audio/[kind]/[id]/route.js.nft.json");
const FORBIDDEN_ROOTS = new Set(["app", "config", "docs", "mcp", "public", "scripts", "tasks", "tests"]);

export function inspectVoiceAudioNft(files, { root = ROOT, nftPath = NFT } = {}) {
  const projectFiles = [];
  const forbidden = [];
  for (const entry of files) {
    const absolute = resolve(dirname(nftPath), entry);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || rel.startsWith(".next/") || rel.startsWith("node_modules/")) continue;
    projectFiles.push(rel);
    const top = rel.split(/[\\/]/)[0];
    if (FORBIDDEN_ROOTS.has(top) || /(?:^|\/)\w[^/]*\.test\.[^/]+$/.test(rel) || /^(?:next\.config\.[^/]+|package\.json|pnpm-lock\.yaml)$/.test(rel)) {
      forbidden.push(rel);
    }
  }
  return { projectFiles: projectFiles.sort(), forbidden: forbidden.sort() };
}

export async function checkVoiceAudioNft() {
  const parsed = JSON.parse(await readFile(NFT, "utf8"));
  const result = inspectVoiceAudioNft(parsed.files ?? []);
  if (result.forbidden.length > 0 || result.projectFiles.length > 12) {
    throw new Error(`voice audio NFT escaped its route closure: ${JSON.stringify(result)}`);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkVoiceAudioNft();
}
