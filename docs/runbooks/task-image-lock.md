# Task image lock provenance and refresh

`config/task-image-lock.json` is the reviewed authority for hosted task-image
identity. Each entry binds three independently meaningful values:

- `lookup_ref` comes from the matching `tasks/<task-id>/task.toml` manifest;
- `manifest_digest` is the immutable registry manifest digest for that exact
  lookup reference;
- `config_digest` is the OCI image config identity reported by Docker as
  `.Id` after acquiring that immutable manifest.

The lock is not regenerated during a run. The runner first derives the exact
task/ref inventory from `TASKS_JSON_B64`, then requires both the locked
repository manifest digest in `.RepoDigests` and the locked config digest in
`.Id`. A tag-only cache hit is never sufficient.

## Refresh procedure

Refresh an entry only when its task manifest intentionally changes or registry
evidence proves that its published image identity changed:

1. Resolve the lookup reference with approved registry tooling and retain the
   registry, UTC time, tool/version, manifest digest, and config digest as PR
   evidence. Never copy a digest from runner logs containing credentials.
2. Acquire and inspect the immutable `repository@manifest_digest`, then confirm
   Docker reports the same manifest in `.RepoDigests` and the proposed
   `config_digest` in `.Id`.
3. Update only the affected lock entry. Do not replace an immutable reference
   with a mutable tag or accept a digest inferred from the tag name.
4. Run `node scripts/check-task-image-lock.mjs` to prove the lock inventory is
   still derived exactly from all checked-in task manifests.
5. Run `pnpm exec vitest run scripts/runner/task-images.test.mjs
   scripts/runner/task-image-readiness.test.mjs` and obtain review of the
   retained registry evidence before deploying to the isolated Development
   project.

Production does not receive image-registry egress. Hosted acceptance therefore
requires a Development Sandbox run proving cache hit or bounded immutable
acquisition, exact post-acquisition identity, and failure before gateway/model
spend when the deadline or identity check fails.

On 2026-08-04, a real isolated Development immutable pull demonstrated that
Docker routing also required the exact public host
`docker-images-prod.s3.dualstack.us-east-1.amazonaws.com`; restricted DNS
denied it before Gateway work. That literal host is Development-only. No S3
wildcard, allow-all policy, or historical Cloudflare/R2 hostname is permitted.
Here, Development-only means the isolated Development project's production
deployment; its Preview deployments do not receive image-registry egress.
