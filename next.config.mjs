/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone：构建出自带精简依赖的产物，便于在 Windows 本地用 `node server.js` 直接启动
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
