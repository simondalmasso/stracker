import type { NextConfig } from "next";

const isExport = process.env.BUILD_EXPORT === "1";

const nextConfig: NextConfig = {
  output: isExport ? "export" : "standalone",
  images: { unoptimized: true },
  reactStrictMode: true,
  ...(isExport ? {} : { async rewrites() { return [
    { source: "/points", destination: "http://127.0.0.1:3003/points" },
    { source: "/api/session/:path*", destination: "http://127.0.0.1:3003/api/session/:path*" },
  ]; } }),
};

export default nextConfig;
