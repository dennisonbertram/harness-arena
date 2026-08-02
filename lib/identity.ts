import { auth } from "@/auth";
import { verifyAgentToken, type AgentIdentity } from "@/lib/agent-token";

export async function resolveIdentity(request: Request): Promise<AgentIdentity | null> {
  const session = await auth();
  const githubId = session?.user?.githubId;
  const githubLogin = session?.user?.githubLogin;
  if (typeof githubId === "number" && typeof githubLogin === "string") return { githubId, githubLogin };

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  try {
    return await verifyAgentToken(authorization.slice("Bearer ".length));
  } catch {
    return null;
  }
}
