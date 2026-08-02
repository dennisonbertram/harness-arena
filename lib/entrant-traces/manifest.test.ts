import { describe, expect, it } from "vitest";
import { validateEntrantTraceManifest } from "./manifest";

const SHA256 = "a".repeat(64);
const MIME = "application/json";

type Manifest = {
  schema_version: "trace-manifest.v1";
  submission_id: string;
  artifacts: Array<{
    kind: "execution" | "rationale";
    schema_version: "execution.v1" | "rationale.v1";
    mime_type: string;
    compression: "none" | "gzip";
    compressed_bytes: number;
    uncompressed_bytes: number;
    sha256: string;
  }>;
};

function validManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schema_version: "trace-manifest.v1",
    submission_id: "sub_01j4a7h4pc9mvwqz6w5a8d2j9r",
    artifacts: [
      {
        kind: "execution",
        schema_version: "execution.v1",
        mime_type: MIME,
        compression: "gzip",
        compressed_bytes: 512,
        uncompressed_bytes: 2_048,
        sha256: SHA256,
      },
      {
        kind: "rationale",
        schema_version: "rationale.v1",
        mime_type: MIME,
        compression: "none",
        compressed_bytes: 256,
        uncompressed_bytes: 256,
        sha256: "b".repeat(64),
      },
    ],
    ...overrides,
  };
}

describe("entrant execution/rationale trace manifest v1", () => {
  it("accepts the versioned, submission-bound allowlisted manifest without private reasoning", () => {
    expect(validateEntrantTraceManifest(validManifest())).toEqual({ ok: true, value: validManifest() });
  });

  it("requires the supported manifest version and a non-empty submission identifier", () => {
    const unsupported = validateEntrantTraceManifest({ ...validManifest(), schema_version: "trace-manifest.v2" });
    const missingSubmission = validateEntrantTraceManifest({ ...validManifest(), submission_id: "" });

    expect(unsupported).toEqual({
      ok: false,
      errors: [{ code: "unsupported_schema_version", path: "schema_version" }],
    });
    expect(missingSubmission).toEqual({ ok: false, errors: [{ code: "required", path: "submission_id" }] });
  });

  it("derives entrant identity from authentication rather than accepting it from the manifest", () => {
    for (const field of ["owner_id", "entrant_id", "ownerId", "entrantId"] as const) {
      const candidate = { ...validManifest(), [field]: "client-controlled-identity" };
      expect(validateEntrantTraceManifest(candidate)).toEqual({
        ok: false,
        errors: [{ code: "forbidden_identity_field", path: field }],
      });
    }
  });

  it("only allows the execution and rationale schema versions with JSON MIME metadata", () => {
    const wrongMime = validManifest({
      artifacts: [{ ...validManifest().artifacts[0], mime_type: "text/plain" }],
    });
    const wrongSchema = validManifest({
      artifacts: [{ ...validManifest().artifacts[1], schema_version: "execution.v1" }],
    });

    expect(validateEntrantTraceManifest(wrongMime)).toEqual({
      ok: false,
      errors: [{ code: "unsupported_mime_type", path: "artifacts[0].mime_type" }],
    });
    expect(validateEntrantTraceManifest(wrongSchema)).toEqual({
      ok: false,
      errors: [{ code: "schema_kind_mismatch", path: "artifacts[0].schema_version" }],
    });
  });

  it("requires each artifact kind at most once", () => {
    const duplicateExecution = validManifest({
      artifacts: [validManifest().artifacts[0], { ...validManifest().artifacts[0], sha256: "b".repeat(64) }],
    });

    expect(validateEntrantTraceManifest(duplicateExecution)).toEqual({
      ok: false,
      errors: [{ code: "duplicate_artifact_kind", path: "artifacts[1].kind" }],
    });
  });

  it("requires exactly one execution artifact and one self-authored rationale artifact", () => {
    const executionOnly = validManifest({ artifacts: [validManifest().artifacts[0]] });
    const rationaleOnly = validManifest({ artifacts: [validManifest().artifacts[1]] });

    expect(validateEntrantTraceManifest(executionOnly)).toEqual({
      ok: false,
      errors: [{ code: "required_artifact_kind", path: "artifacts.rationale" }],
    });
    expect(validateEntrantTraceManifest(rationaleOnly)).toEqual({
      ok: false,
      errors: [{ code: "required_artifact_kind", path: "artifacts.execution" }],
    });
  });

  it("enforces non-negative byte metadata, compressed <= uncompressed, and the 1 MiB / 8 MiB v1 ceilings", () => {
    const negative = validManifest({
      artifacts: [{ ...validManifest().artifacts[0], compressed_bytes: -1 }],
    });
    const inverted = validManifest({
      artifacts: [{ ...validManifest().artifacts[0], compressed_bytes: 513, uncompressed_bytes: 512 }],
    });
    const tooLargeCompressed = validManifest({
      artifacts: [{ ...validManifest().artifacts[0], compressed_bytes: 1_048_577, uncompressed_bytes: 1_048_577 }],
    });
    const tooLargeUncompressed = validManifest({
      artifacts: [{ ...validManifest().artifacts[0], compressed_bytes: 1_048_576, uncompressed_bytes: 8_388_609 }],
    });

    expect(validateEntrantTraceManifest(negative)).toEqual({
      ok: false,
      errors: [{ code: "invalid_byte_count", path: "artifacts[0].compressed_bytes" }],
    });
    expect(validateEntrantTraceManifest(inverted)).toEqual({
      ok: false,
      errors: [{ code: "compressed_bytes_exceed_uncompressed", path: "artifacts[0]" }],
    });
    expect(validateEntrantTraceManifest(tooLargeCompressed)).toEqual({
      ok: false,
      errors: [{ code: "compressed_bytes_exceed_limit", path: "artifacts[0].compressed_bytes" }],
    });
    expect(validateEntrantTraceManifest(tooLargeUncompressed)).toEqual({
      ok: false,
      errors: [{ code: "uncompressed_bytes_exceed_limit", path: "artifacts[0].uncompressed_bytes" }],
    });
  });

  it("requires a lowercase 64-hex SHA-256 digest", () => {
    const uppercase = validManifest({ artifacts: [{ ...validManifest().artifacts[0], sha256: "A".repeat(64) }] });
    const short = validManifest({ artifacts: [{ ...validManifest().artifacts[0], sha256: "a".repeat(63) }] });

    expect(validateEntrantTraceManifest(uppercase)).toEqual({
      ok: false,
      errors: [{ code: "invalid_sha256", path: "artifacts[0].sha256" }],
    });
    expect(validateEntrantTraceManifest(short)).toEqual({
      ok: false,
      errors: [{ code: "invalid_sha256", path: "artifacts[0].sha256" }],
    });
  });

  it("rejects forbidden sensitive metadata or content fields anywhere in the manifest", () => {
    for (const field of [
      "prompt",
      "token",
      "cookie",
      "env",
      "privateKey",
      "private_key",
      "api_key",
      "authorization",
      "signedUrl",
      "signed_url",
      "chain_of_thought",
    ] as const) {
      const candidate = { ...validManifest(), [field]: "must-not-store" };
      expect(validateEntrantTraceManifest(candidate)).toEqual({
        ok: false,
        errors: [{ code: "forbidden_sensitive_field", path: field }],
      });
    }

    const nested = {
      ...validManifest(),
      artifacts: [{ ...validManifest().artifacts[1], content: { private_reasoning: "hidden chain of thought" } }],
    };
    expect(validateEntrantTraceManifest(nested)).toEqual({
      ok: false,
      errors: [{ code: "forbidden_sensitive_field", path: "artifacts[0].content.private_reasoning" }],
    });
  });

  it("rejects unknown manifest and artifact fields so the versioned schema cannot silently expand", () => {
    expect(validateEntrantTraceManifest({ ...validManifest(), notes: "unversioned extension" })).toEqual({
      ok: false,
      errors: [{ code: "unexpected_field", path: "notes" }],
    });

    const withArtifactExtension = validManifest({
      artifacts: [{ ...validManifest().artifacts[0], encoding: "custom" }, validManifest().artifacts[1]],
    });
    expect(validateEntrantTraceManifest(withArtifactExtension)).toEqual({
      ok: false,
      errors: [{ code: "unexpected_field", path: "artifacts[0].encoding" }],
    });
  });

  it("reports all independent failures in stable path/code order", () => {
    const invalid = {
      ...validManifest(),
      submission_id: "",
      artifacts: [
        { ...validManifest().artifacts[0], mime_type: "text/plain", sha256: "NOT-A-DIGEST" },
        { ...validManifest().artifacts[1], uncompressed_bytes: 8_388_609 },
      ],
      signedUrl: "https://storage.example/trace?signature=secret",
    };

    expect(validateEntrantTraceManifest(invalid)).toEqual({
      ok: false,
      errors: [
        { code: "required", path: "submission_id" },
        { code: "unsupported_mime_type", path: "artifacts[0].mime_type" },
        { code: "invalid_sha256", path: "artifacts[0].sha256" },
        { code: "uncompressed_bytes_exceed_limit", path: "artifacts[1].uncompressed_bytes" },
        { code: "forbidden_sensitive_field", path: "signedUrl" },
      ],
    });
  });
});
