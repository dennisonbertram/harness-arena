"use client";

import { useEffect, useRef, useState } from "react";
import { UNKNOWN_GITHUB_LOGIN } from "@/lib/github";

// Skips the real-avatar request entirely for the "unknown" login (a
// pre-login stray blob, not a real GitHub account); falls back to the same
// placeholder for a real login whose avatar 404s (renamed/deleted account).
export function GithubAvatar({ githubLogin, size = 24 }: { githubLogin: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // A cached/fast 404 can finish failing before hydration attaches onError —
  // native image error events don't replay — so also check the already-
  // settled state once on mount.
  useEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0) {
      setBroken(true);
    }
  }, []);

  const baseStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    verticalAlign: "middle",
    marginRight: 8,
  };

  if (githubLogin === UNKNOWN_GITHUB_LOGIN || broken) {
    return (
      <span
        aria-hidden="true"
        style={{
          ...baseStyle,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--gray-alpha-400)",
          color: "var(--gray-700)",
          fontSize: Math.round(size * 0.46),
        }}
      >
        ?
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- external GitHub-hosted avatar, not an optimizable local asset
    <img
      ref={imgRef}
      // ?size= matters a lot: without it GitHub serves the avatar at its full
      // stored resolution (460x460 for a real account) into a 20-24px circle.
      // 2x the rendered size covers retina and drops the payload ~99%.
      src={`https://github.com/${githubLogin}.png?size=${size * 2}`}
      alt={githubLogin}
      style={baseStyle}
      // Deliberately NOT lazy. These sit above the fold in the first rows of
      // the leaderboard, and lazy defers the fetch past layout -- which is
      // what made avatars visibly pop in and out on every render. At ~2KB
      // each after the size cap, eager is the cheaper trade.
      loading="eager"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}
