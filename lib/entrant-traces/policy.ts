import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";

type Kind = "execution" | "rationale";
type Compression = "none" | "gzip";
type Artifact = { kind: Kind; compression: Compression; sha256: string; uncompressed_bytes: number; bytes: Uint8Array };
type PublicFailure = { ok: false; disposition: "rejected" | "manual_review"; error: { code: string } };
type PublicSuccess = { ok: true; verified_sha256: string };
type Scan = (document: unknown) => Promise<unknown> | unknown;

const SHA256 = /^[0-9a-f]{64}$/;
const sensitive = /(?:access[_ -]?token|token|cookie|\benv(?:ironment)?\b|private[ _-]?key|api[ _-]?key|authorization|signed[ _-]?url|\bprompt\b|chain[ _-]?of[ _-]?thought|private[ _-]?reasoning|\bthinking\b|\breasoning\b)/i;
const executionKeys = new Set(["schema_version", "events"]);
const eventKeys = new Set(["at", "type", "tool", "exit_code"]);
const rationaleKeys = new Set(["schema_version", "authored_by", "summary"]);

function freeze<Value>(value: Value): Value {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(disposition: PublicFailure["disposition"], code: string): PublicFailure {
  return freeze({ ok: false, disposition, error: { code } });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsSensitive(value: unknown): boolean {
  if (typeof value === "string") return sensitive.test(value);
  if (Array.isArray(value)) return value.some(containsSensitive);
  if (!record(value)) return false;
  return Object.entries(value).some(([key, child]) => sensitive.test(key) || containsSensitive(child));
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function allowlisted(kind: Kind, value: unknown): boolean {
  if (!record(value) || containsSensitive(value)) return false;
  if (kind === "execution") {
    return value.schema_version === "execution.v1" && exactKeys(value, executionKeys)
      && Array.isArray(value.events)
      && value.events.every((event) => record(event) && exactKeys(event, eventKeys) && typeof event.type === "string");
  }
  return value.schema_version === "rationale.v1" && value.authored_by === "entrant"
    && typeof value.summary === "string" && exactKeys(value, rationaleKeys);
}

async function boundedGunzip(input: Uint8Array, limit: number): Promise<Buffer | null> {
  const gunzip = createGunzip();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    Readable.from([Buffer.from(input)]).pipe(gunzip);
    for await (const value of gunzip) {
      const chunk = Buffer.from(value as Uint8Array);
      size += chunk.byteLength;
      if (size > limit) {
        gunzip.destroy();
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch {
    return null;
  }
}

const scanTimedOut = Symbol("scan timed out");

/**
 * Validates private artifact bytes after Blob has verified their compressed
 * digest. All errors are stable, deliberately non-diagnostic public values.
 */
export function createEntrantTracePolicy(options: { maxUncompressedBytes: number; scanTimeoutMs: number; scan?: Scan }) {
  if (!Number.isSafeInteger(options.maxUncompressedBytes) || options.maxUncompressedBytes < 1) throw new Error("invalid trace policy limits");
  if (!Number.isSafeInteger(options.scanTimeoutMs) || options.scanTimeoutMs < 1) throw new Error("invalid trace policy limits");
  return {
    async verify(input: Artifact): Promise<PublicSuccess | PublicFailure> {
      if (!SHA256.test(input.sha256) || !(input.bytes instanceof Uint8Array)) return fail("rejected", "invalid_artifact");
      const compressedDigest = createHash("sha256").update(input.bytes).digest("hex");
      // Keep the cryptographic comparison here so callers cannot accidentally
      // parse an unverified byte stream, even when Blob has already checked it.
      if (compressedDigest !== input.sha256) return fail("rejected", "checksum_mismatch");

      const bytes = input.compression === "gzip"
        ? await boundedGunzip(input.bytes, options.maxUncompressedBytes)
        : Buffer.from(input.bytes);
      if (!bytes) return fail("rejected", "uncompressed_bytes_exceed_limit");
      if (bytes.byteLength > options.maxUncompressedBytes) return fail("rejected", "uncompressed_bytes_exceed_limit");
      if (bytes.byteLength !== input.uncompressed_bytes) return fail("rejected", "uncompressed_size_mismatch");

      let document: unknown;
      try { document = JSON.parse(bytes.toString("utf8")); } catch { return fail("manual_review", "invalid_json"); }
      if (containsSensitive(document)) return fail("rejected", "sensitive_content");
      if (!allowlisted(input.kind, document)) return fail("rejected", "schema_not_allowlisted");

      if (!options.scan) return fail("manual_review", "scanner_unavailable");

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<typeof scanTimedOut>((resolve) => {
          timer = setTimeout(() => resolve(scanTimedOut), options.scanTimeoutMs);
        });
        const outcome = await Promise.race([Promise.resolve(options.scan(document)), timeout]);
        if (outcome === scanTimedOut) return fail("manual_review", "scan_timeout");
        if (record(outcome) && outcome.ok === false) return fail("rejected", "scan_rejected");
      } catch {
        return fail("manual_review", "scan_error");
      } finally {
        if (timer) clearTimeout(timer);
      }
      return freeze({ ok: true, verified_sha256: input.sha256 });
    },
  };
}
