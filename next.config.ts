import type { NextConfig } from "next";

// scripts/init.sh preempts every key found in Next's development env files
// with an empty value before Next starts. Once Next has completed env loading,
// remove those placeholders so application code sees the keys as absent.
if (process.env.HARNESS_LOCAL_INIT === "1") {
  for (const key of (process.env.LOCAL_NEUTRALIZED_ENV_KEYS ?? "").split(",").filter(Boolean)) {
    if (process.env[key] === "") delete process.env[key];
  }
}

const nextConfig: NextConfig = {
  // The competition moved from /competition to / (the homepage). A 308 keeps
  // already-shared links working instead of 404ing them.
  async redirects() {
    return [{ source: "/competition", destination: "/", permanent: true }];
  },
};

export default nextConfig;
