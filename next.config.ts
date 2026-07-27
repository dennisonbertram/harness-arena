import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The competition moved from /competition to / (the homepage). A 308 keeps
  // already-shared links working instead of 404ing them.
  async redirects() {
    return [{ source: "/competition", destination: "/", permanent: true }];
  },
};

export default nextConfig;
