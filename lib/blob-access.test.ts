import { describe, expect, it } from "vitest";
import { resolveBlobAccess } from "./blob-access";

function oidc(payload: Record<string, unknown>): string {
  return [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}

describe("resolveBlobAccess", () => {
  it("defaults the isolated Development project to private storage", () => {
    expect(resolveBlobAccess({
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_dev_secret",
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      HARNESS_BLOB_STORE_ID: "store_dev",
      BLOB_STORE_ID: "store_dev",
    })).toEqual({ access: "private" });
  });

  it("fails closed when a private Development store is configured public", () => {
    expect(() => resolveBlobAccess({
      BLOB_READ_WRITE_TOKEN: "rw",
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      BLOB_ACCESS: "public",
    })).toThrow("storage misconfigured: Development Blob access must be private");
  });

  it("rejects an unknown access mode instead of silently falling back", () => {
    expect(() => resolveBlobAccess({ BLOB_READ_WRITE_TOKEN: "rw", BLOB_ACCESS: "protected" })).toThrow(
      "storage misconfigured: BLOB_ACCESS must be public or private",
    );
  });

  it("preserves the production-compatible public default outside Development", () => {
    expect(resolveBlobAccess({ BLOB_READ_WRITE_TOKEN: "rw" })).toEqual({ access: "public" });
  });

  it("rejects a Development store identity missing or mixed with the configured store", () => {
    const base = { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_dev_secret", VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA" };
    expect(() => resolveBlobAccess(base)).toThrow("Development Blob store identity is required");
    expect(() => resolveBlobAccess({ ...base, HARNESS_BLOB_STORE_ID: "store_dev", BLOB_STORE_ID: "store_other" })).toThrow("Blob store identity mismatch");
  });

  it("verifies the active read-write token is bound to the declared Development store", () => {
    const base = {
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      HARNESS_BLOB_STORE_ID: "store_dev",
      BLOB_STORE_ID: "store_dev",
    };
    expect(resolveBlobAccess({ ...base, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_dev_secret" })).toEqual({ access: "private" });
    expect(() => resolveBlobAccess({ ...base, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_other_secret" }))
      .toThrow("Blob credential store identity mismatch");
    expect(() => resolveBlobAccess({ ...base, BLOB_READ_WRITE_TOKEN: "opaque-token" }))
      .toThrow("Blob credential store identity unavailable");
  });

  it("requires BLOB_STORE_ID to bind OIDC and harness identity consistently in Development", () => {
    expect(() => resolveBlobAccess({
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      HARNESS_BLOB_STORE_ID: "store_dev",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_dev_secret",
      VERCEL_OIDC_TOKEN: "oidc",
    })).toThrow("Development BLOB_STORE_ID is required");
  });

  it.each([
    ["malformed", "not-a-jwt"],
    ["expired", oidc({ exp: 1, project_id: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA" })],
    ["unrefreshable", oidc({ exp: Math.floor(Date.now() / 1000) + 10, project_id: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA" })],
  ])("rejects %s explicit OIDC instead of allowing SDK fallback", (_case, token) => {
    expect(() => resolveBlobAccess({
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      HARNESS_BLOB_STORE_ID: "store_dev",
      BLOB_STORE_ID: "store_dev",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_dev_secret",
      VERCEL_OIDC_TOKEN: token,
    })).toThrow(/OIDC/i);
  });

  it("rejects coexisting OIDC and a read-write token bound to another store", () => {
    expect(() => resolveBlobAccess({
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
      HARNESS_BLOB_STORE_ID: "store_dev",
      BLOB_STORE_ID: "store_dev",
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_other_secret",
      VERCEL_OIDC_TOKEN: oidc({ exp: Math.floor(Date.now() / 1000) + 3600, project_id: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA" }),
    })).toThrow("Blob credential store identity mismatch");
  });
});
