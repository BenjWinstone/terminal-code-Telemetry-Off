import type { NextConfig } from "next";

const RELEASES = "https://tode-releases.zenbu-labs.workers.dev";

const nextConfig: NextConfig = {
  // the tode CLI's own lockfile sits one level up, so pin the root explicitly
  turbopack: { root: __dirname },

  /* A rewrite proxies rather than redirects, so tode.sh/install answers with
     the worker's installer and the address never changes. Only the script goes
     through Vercel. The worker builds its download urls from the host it sees,
     which is the workers.dev one, so the 130MB tarball goes straight from R2 to
     the user and never crosses Vercel's bandwidth. */
  async rewrites() {
    return [
      { source: "/install", destination: RELEASES },
      { source: "/install/:path*", destination: `${RELEASES}/:path*` },
    ];
  },
};

export default nextConfig;
