import path from 'path';
import type { NextConfig } from "next";

// Host
const HOST = process.env.HOST || '127.0.0.1';

// Read API port from environment variable (set by dev script) or default to 3001
const API_PORT = process.env.API_PORT || '3001';

// Data directory for modules
const DATA_DIR = process.env.SHEET_DELVER_DATA || path.join(process.cwd(), 'data');
const modulesDir = path.join(DATA_DIR, 'modules');

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
  turbopack: {
    resolveAlias: {
      '@modules': [
        path.join(process.cwd(), 'src', 'modules'),
        modulesDir
      ],
      '@client': path.join(process.cwd(), 'src', 'client'),
      '@shared': path.join(process.cwd(), 'src', 'shared'),
      '@server': path.join(process.cwd(), 'src', 'server'),
      '@core': path.join(process.cwd(), 'src', 'server', 'core'),
      '@app': path.join(process.cwd(), 'src', 'app'),
      '@': path.join(process.cwd(), 'src'),
      '@sheet-delver/sdk': path.join(process.cwd(), 'src', 'shared', 'sdk', 'index.ts'),
    }
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias['@modules'] = [
      path.join(process.cwd(), 'src', 'modules'),
      modulesDir
    ];
    return config;
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/socket.io/',
          destination: `http://${HOST}:${API_PORT}/socket.io/`
        },
        {
          source: '/socket.io/:path*',
          destination: `http://${HOST}:${API_PORT}/socket.io/:path*`
        }
      ],
      afterFiles: [
        {
          source: '/api/admin/:path*',
          destination: `http://${HOST}:${API_PORT}/admin/:path*`
        },
        {
          source: '/api/:path*',
          destination: `http://${HOST}:${API_PORT}/api/:path*`
        }
      ]
    };
  }
};

export default nextConfig;
