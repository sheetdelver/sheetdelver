import path from 'path';
import type { NextConfig } from "next";

// Host
const HOST = process.env.HOST || '127.0.0.1';

// Read API port from environment variable (set by dev script) or default to 3001
const API_PORT = process.env.API_PORT || '3001';

// Data directory for modules
const DATA_DIR = process.env.SHEET_DELVER_DATA || path.join(process.cwd(), 'data');
const modulesDir = path.join(DATA_DIR, 'modules');
// Local dev modules — same default as getLocalModulesDir() on the server side.
// Overridable via SHEET_DELVER_LOCAL_MODULES so dev and managed installs stay separate.
const localModulesDir = process.env.SHEET_DELVER_LOCAL_MODULES
    ? path.resolve(process.env.SHEET_DELVER_LOCAL_MODULES)
    : path.join(DATA_DIR, 'local', 'modules');

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
  turbopack: {
    resolveAlias: {
      '@modules': [
        path.join(process.cwd(), 'src', 'modules'),
        modulesDir,
      ],
      '@local-modules': localModulesDir,
      // Points to the data directory — home for environment-specific generated
      // files (module-ui-registry.ts) that depend on what is installed at runtime.
      '@data-registry': DATA_DIR,
      '@client': path.join(process.cwd(), 'src', 'client'),
      '@shared': path.join(process.cwd(), 'src', 'shared'),
      '@server': path.join(process.cwd(), 'src', 'server'),
      '@core': path.join(process.cwd(), 'src', 'server', 'core'),
      '@app': path.join(process.cwd(), 'src', 'app'),
      '@': path.join(process.cwd(), 'src'),
      // Point to the directory, not the file — Turbopack rejects file-path aliases
      // as "server relative imports" but handles directory aliases correctly.
      '@sheet-delver/sdk': path.join(process.cwd(), 'src', 'shared', 'sdk'),
    }
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias['@modules'] = [
      path.join(process.cwd(), 'src', 'modules'),
      modulesDir,
    ];
    config.resolve.alias['@local-modules'] = localModulesDir;
    config.resolve.alias['@data-registry'] = DATA_DIR;
    config.resolve.alias['@sheet-delver/sdk'] = path.join(process.cwd(), 'src', 'shared', 'sdk');
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
