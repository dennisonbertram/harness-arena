import { NextRequest, NextResponse } from "next/server";
import { getAgentNetworkRuntime } from "@/lib/agent-network-runtime";

function error(code: string, status: number) { return NextResponse.json({ error: { code } }, { status }); }
function authenticationError(code: string) {
  if (code === "unauthenticated") return error("unauthenticated", 401);
  if (code === "session_unavailable") return error("session_unavailable", 503);
  return error("insufficient_scope", 403);
}
function query(request: NextRequest): { competition_id: string; submission_id: string } | null {
  const params = request.nextUrl.searchParams;
  if ([...params.keys()].some((key) => key !== "competition_id" && key !== "submission_id")) return null;
  const competition_id = params.get("competition_id");
  const submission_id = params.get("submission_id");
  if (!competition_id || !submission_id || competition_id.length > 256 || submission_id.length > 256) return null;
  return { competition_id, submission_id };
}

export async function GET(request: NextRequest) {
  try {
    const runtime = getAgentNetworkRuntime();
    const authentication = await runtime.authenticateAgentSession(request, { requiredScopes: ["payouts:read"] });
    if (!authentication.ok) return authenticationError(authentication.error.code);
    const actor = authentication.actor;
    const input = query(request);
    if (!input) return error("invalid_query", 400);
    // The runtime capability is intentionally injected through this narrow
    // adapter so the route remains fail-closed until the payout service slice
    // is present in a deployment.
    const capability = runtime as unknown as { getOwnPayoutEligibility(input: { actor: typeof actor; competition_id: string; submission_id: string }): Promise<{ ok: true; eligibility: unknown } | { ok: false; error: { code: string } }> };
    const result = await capability.getOwnPayoutEligibility({ actor, ...input });
    if (!result.ok) return error(result.error.code === "not_found" ? "not_found" : "snapshot_unavailable", result.error.code === "not_found" ? 404 : 503);
    return NextResponse.json({ eligibility: result.eligibility });
  } catch { return error("snapshot_unavailable", 503); }
}
