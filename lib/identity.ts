import { auth } from "@/auth";
import { verifyAgentToken, type AgentIdentity } from "@/lib/agent-token";
import { resolveSeededDevelopmentIdentity } from "@/lib/development-identity";

export async function resolveIdentity(request: Request): Promise<AgentIdentity | null> {
  const session = await auth();
  const githubId = session?.user?.githubId;
  const githubLogin = session?.user?.githubLogin;
  if (typeof githubId === "number" && typeof githubLogin === "string") return { githubId, githubLogin };

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return resolveSeededDevelopmentIdentity(request);
  try {
    return await verifyAgentToken(authorization.slice("Bearer ".length));
  } catch {
    return resolveSeededDevelopmentIdentity(request);
  }
}
