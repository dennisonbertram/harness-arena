<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Use Vercel CLI for production evidence

For every task involving Vercel production or preview behavior — deployments,
runtime failures, missing or stale data, AI Gateway/provider behavior, slow
requests, or a discrepancy between local and hosted behavior — use the Vercel
CLI early as a mandatory evidence source. Do not rely only on the dashboard,
browser symptoms, repository inference, or application APIs.

At minimum:

1. Identify the deployment actually serving the target hostname with
   `vercel ls` and/or `vercel inspect`.
2. Query runtime logs with `vercel logs`, using the relevant deployment,
   environment, time range, status code, level, request ID, or text filters.
3. After a fix is deployed, repeat the CLI checks against the new production
   deployment and confirm both the expected requests and the absence of the
   original errors.
4. State which facts came from Vercel and which could not. Vercel runtime logs
   only contain platform metadata and output the application emitted; request
   bodies, prompt sizes, proxy translations, and provider responses require
   structured application logging if they are not exposed by a documented
   Vercel API.

Use the authenticated Vercel REST API or SDK when it provides information the
CLI cannot query directly. Never print or commit Vercel tokens. If CLI/API
access is unavailable, report the exact authentication or permission blocker
instead of silently proceeding without production evidence.

# Regression tests come first

**Before writing any new feature, write the test that would have caught the
last bug in that area — and watch it fail.** A test authored after the fix, and
never seen red, proves nothing: it may assert on behaviour that was already
passing.

Non-negotiable for every change:

1. **Red first.** Run the new test against the unfixed code and confirm it
   fails *for the reason you expect*. A test that passes before the fix is not
   a regression test.
2. **Derive, don't enumerate.** When something must stay in sync with something
   else, compute the expectation instead of hand-listing it. A run failed in
   production with `Cannot find module '.../gateway-proxy.mjs'` because the
   sandbox bundle copied a hand-maintained file list that a new import was not
   on. The fix was not adding the file — it was deriving the required set from
   the runner's actual imports, so the same class of bug cannot recur.
3. **Assert the failure mode, not the happy path.** The interesting cases are
   the judge being down, the blob read that half-succeeds, the provider option
   the gateway accepts and silently ignores. Those are what break in
   production; the happy path is what you already checked by hand.
4. **Verify the test can fail.** For a fix, revert it and re-run. For a guard,
   break the thing it guards. If you cannot make it go red, you have not
   written a test — say so rather than claiming coverage.

Coverage thresholds are enforced (90% statements) but they measure lines
executed, not behaviour pinned. Clearing the gate is not evidence the change is
safe.
