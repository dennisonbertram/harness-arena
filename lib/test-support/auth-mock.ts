import type { Session } from "next-auth";

type MockedAuth = {
  mockReset: () => void;
  mockResolvedValue: (value: Session | null) => void;
  mockResolvedValueOnce: (value: Session | null) => void;
};

// next-auth v5's `auth()` export is overloaded (bare call for reading a
// session vs. a middleware-wrapping call), which confuses vi.mocked()'s
// overload resolution against a plain vi.fn(). This app only ever calls the
// bare, session-reading form — cast once via this helper rather than at
// every call site.
export function asMockAuth(auth: unknown): MockedAuth {
  return auth as MockedAuth;
}

export function githubSession(githubId: number, githubLogin = `user-${githubId}`): Session {
  return {
    user: { githubId, githubLogin },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
}
