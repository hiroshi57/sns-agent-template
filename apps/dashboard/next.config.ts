import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Vercel KV は Edge Runtime 非対応のため Node.js runtime を使用
};

export default nextConfig;
