/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript sources compiled to CJS; Next needs to run them
  // through its own pipeline so they participate in tree-shaking and RSC boundaries.
  transpilePackages: ['@forge/contracts', '@forge/sdk'],
  // The console is a private operations tool served behind the same origin as the API
  // in Docker; these headers are cheap defence in depth for the standalone dev server.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  // `standalone` produces the self-contained server the Docker image runs. It is opt-in
  // rather than always-on because generating it copies the traced dependency tree using
  // symlinks, which fails with EPERM on Windows unless the shell is elevated or
  // Developer Mode is enabled — a local `next build` should not require either.
  // The Dockerfile sets NEXT_OUTPUT_STANDALONE=1.
  ...(process.env.NEXT_OUTPUT_STANDALONE === '1' ? { output: 'standalone' } : {}),
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
