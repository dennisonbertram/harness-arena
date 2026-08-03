import { describe, expect, it } from "vitest";
import { resolveBlobAccess } from "./blob-access";

describe("resolveBlobAccess", () => {
  it("defaults the isolated Development project to private storage", () => {
    expect(resolveBlobAccess({
      BLOB_READ_WRITE_TOKEN: "rw",
      VERCEL_PROJECT_ID: "prj_YcSCWVj8OBPQ9XmQVuCGz4AMV2WA",
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
});
