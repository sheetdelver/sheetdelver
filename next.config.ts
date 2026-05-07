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

// Turbopack requires project-relative paths (starting with ./) for non-wildcard
// aliases. Absolute paths (from path.join / path.resolve) are treated as
// server-relative URLs and rejected. Wildcard aliases (@client/*, @shared/*)
// work fine with absolute paths because Turbopack uses them as prefix
// substitutions, but exact aliases (@sheet-delver/sdk, @data-registry) must
// be relative. Webpack handles absolute paths in all cases.
const turboRelative = (absPath: string) =>
    './' + path.relative(process.cwd(), absPath).replace(/\\/g, '/');

const nextConfig: NextConfig = {
  skipTrailingSlashRedirect: true,
  turbopack: {
    resolveAlias: {
      '@modules': [
        path.join(process.cwd(), 'src', 'modules'),
        modulesDir,
      ],
      '@local-modules': localModulesDir,
      // Prefix alias (used as @data-registry/module-ui-registry) — absolute path
      // works fine for prefix aliases; the "server relative" restriction only
      // applies to exact (no sub-path) aliases like @sheet-delver/sdk below.
      '@data-registry': DATA_DIR,
      '@client': path.join(process.cwd(), 'src', 'client'),
      '@shared': path.join(process.cwd(), 'src', 'shared'),
      '@server': path.join(process.cwd(), 'src', 'server'),
      '@core': path.join(process.cwd(), 'src', 'server', 'core'),
      '@app': path.join(process.cwd(), 'src', 'app'),
      '@': path.join(process.cwd(), 'src'),
      '@sheet-delver/sdk': turboRelative(path.join(process.cwd(), 'src', 'shared', 'sdk')),
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

    // Tell webpack's file watcher to ignore runtime JSON files in DATA_DIR.
    // Without this, server writes to state.json / artifacts.json (triggered by
    // actor loading, registry scans, etc.) are detected by the dev server and
    // cause a full HMR page reload in every open browser tab.
    // Source file changes (.ts/.tsx) in data/ still trigger rebuilds normally.
    config.watchOptions = {
        ...config.watchOptions,
        ignored: `${DATA_DIR.replace(/\\/g, '/')}/**/*.json`,
    };

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
