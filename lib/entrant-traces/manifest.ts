export type TraceManifestError = {
  code: string;
  path: string;
};

export type EntrantTraceArtifact = {
  kind: "execution" | "rationale";
  schema_version: "execution.v1" | "rationale.v1";
  mime_type: "application/json";
  compression: "none" | "gzip";
  compressed_bytes: number;
  uncompressed_bytes: number;
  sha256: string;
};

export type EntrantTraceManifest = {
  schema_version: "trace-manifest.v1";
  submission_id: string;
  artifacts: [EntrantTraceArtifact, EntrantTraceArtifact];
};

export type TraceManifestValidationResult =
  | { ok: true; value: EntrantTraceManifest }
  | { ok: false; errors: TraceManifestError[] };

const MAX_COMPRESSED_BYTES = 1_048_576;
const MAX_UNCOMPRESSED_BYTES = 8_388_608;
const MANIFEST_KEYS = new Set(["schema_version", "submission_id", "artifacts"]);
const ARTIFACT_KEYS = new Set([
  "kind",
  "schema_version",
  "mime_type",
  "compression",
  "compressed_bytes",
  "uncompressed_bytes",
  "sha256",
]);

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreeze<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathFor(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function normalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function forbiddenKeyCode(key: string): TraceManifestError["code"] | undefined {
  const normalized = normalizedKey(key);
  if (["owner", "ownerid", "entrant", "entrantid"].includes(normalized)) return "forbidden_identity_field";

  if (
    normalized.includes("prompt") ||
    normalized.includes("token") ||
    normalized.includes("cookie") ||
    normalized.includes("env") ||
    normalized.includes("privatekey") ||
    normalized.includes("apikey") ||
    normalized.includes("authorization") ||
    normalized.includes("signedurl") ||
    normalized.includes("chainofthought") ||
    normalized.includes("privatereasoning") ||
    normalized === "reasoning" ||
    normalized === "thinking"
  ) {
    return "forbidden_sensitive_field";
  }
  return undefined;
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => forbiddenKeyCode(key) !== undefined || containsForbiddenKey(value[key]));
}

function collectUnknownAndForbiddenFields(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string> | undefined,
  errors: TraceManifestError[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnknownAndForbiddenFields(item, `${path}[${index}]`, undefined, errors));
    return;
  }
  if (!isRecord(value)) return;

  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    const childPath = pathFor(path, key);
    const forbidden = forbiddenKeyCode(key);
    if (forbidden) {
      errors.push({ code: forbidden, path: childPath });
      continue;
    }

    if (allowedKeys?.has(key)) {
      if (key === "artifacts") {
        if (Array.isArray(child)) {
          child.forEach((artifact, index) =>
            collectUnknownAndForbiddenFields(artifact, `${childPath}[${index}]`, ARTIFACT_KEYS, errors),
          );
        }
      }
      continue;
    }

    // Do not mask a sensitive descendant behind an otherwise unknown wrapper
    // such as { content: { private_reasoning: ... } }.
    if (containsForbiddenKey(child)) {
      collectUnknownAndForbiddenFields(child, childPath, undefined, errors);
    } else {
      errors.push({ code: "unexpected_field", path: childPath });
    }
  }
}

function validateArtifact(artifact: unknown, index: number, errors: TraceManifestError[]): boolean {
  const path = `artifacts[${index}]`;
  if (!isRecord(artifact)) {
    errors.push({ code: "invalid_type", path });
    return false;
  }

  const startingErrors = errors.length;
  const kind = artifact.kind;
  if (kind !== "execution" && kind !== "rationale") {
    errors.push({ code: "invalid_artifact_kind", path: `${path}.kind` });
  }

  const schemaVersion = artifact.schema_version;
  const expectedSchema = kind === "execution" ? "execution.v1" : kind === "rationale" ? "rationale.v1" : undefined;
  if (schemaVersion !== expectedSchema) {
    errors.push({ code: "schema_kind_mismatch", path: `${path}.schema_version` });
  }

  if (artifact.mime_type !== "application/json") {
    errors.push({ code: "unsupported_mime_type", path: `${path}.mime_type` });
  }
  if (artifact.compression !== "none" && artifact.compression !== "gzip") {
    errors.push({ code: "unsupported_compression", path: `${path}.compression` });
  }

  const compressed = artifact.compressed_bytes;
  const uncompressed = artifact.uncompressed_bytes;
  if (typeof compressed !== "number" || !Number.isSafeInteger(compressed) || compressed < 0) {
    errors.push({ code: "invalid_byte_count", path: `${path}.compressed_bytes` });
  } else if (typeof uncompressed !== "number" || !Number.isSafeInteger(uncompressed) || uncompressed < 0) {
    errors.push({ code: "invalid_byte_count", path: `${path}.uncompressed_bytes` });
  } else if (compressed > uncompressed) {
    errors.push({ code: "compressed_bytes_exceed_uncompressed", path });
  } else if (compressed > MAX_COMPRESSED_BYTES) {
    errors.push({ code: "compressed_bytes_exceed_limit", path: `${path}.compressed_bytes` });
  } else if (uncompressed > MAX_UNCOMPRESSED_BYTES) {
    errors.push({ code: "uncompressed_bytes_exceed_limit", path: `${path}.uncompressed_bytes` });
  }

  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
    errors.push({ code: "invalid_sha256", path: `${path}.sha256` });
  }

  return errors.length === startingErrors;
}

/**
 * Validates untrusted public trace metadata. Artifact bytes are deliberately
 * out of scope: the manifest must never carry prompts, credentials, or hidden
 * chain-of-thought material.
 */
export function validateEntrantTraceManifest(input: unknown): TraceManifestValidationResult {
  const errors: TraceManifestError[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ code: "invalid_type", path: "" }] };

  if (input.schema_version !== "trace-manifest.v1") {
    errors.push({ code: "unsupported_schema_version", path: "schema_version" });
  }
  if (typeof input.submission_id !== "string" || input.submission_id.trim().length === 0) {
    errors.push({ code: "required", path: "submission_id" });
  } else if (input.submission_id.length > 256) {
    errors.push({ code: "value_too_long", path: "submission_id" });
  }

  let artifactsAreIndividuallyValid = false;
  if (!Array.isArray(input.artifacts)) {
    errors.push({ code: "invalid_type", path: "artifacts" });
  } else {
    artifactsAreIndividuallyValid = true;
    for (const [index, artifact] of input.artifacts.entries()) {
      artifactsAreIndividuallyValid = validateArtifact(artifact, index, errors) && artifactsAreIndividuallyValid;
    }

    if (artifactsAreIndividuallyValid) {
      const seenKinds = new Set<string>();
      let hasDuplicate = false;
      for (const [index, artifact] of input.artifacts.entries()) {
        const kind = (artifact as Record<string, unknown>).kind as string;
        if (seenKinds.has(kind)) {
          errors.push({ code: "duplicate_artifact_kind", path: `artifacts[${index}].kind` });
          hasDuplicate = true;
        }
        seenKinds.add(kind);
      }
      // Completeness is a derived error. When a policy violation is already
      // present, report that violation without obscuring it with a missing-kind
      // consequence of an intentionally rejected artifact.
      if (!hasDuplicate && !containsForbiddenKey(input)) {
        for (const kind of ["execution", "rationale"] as const) {
          if (!seenKinds.has(kind)) errors.push({ code: "required_artifact_kind", path: `artifacts.${kind}` });
        }
      }
    }
  }

  collectUnknownAndForbiddenFields(input, "", MANIFEST_KEYS, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: cloneAndFreeze(input) as EntrantTraceManifest };
}
