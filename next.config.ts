import path from 'path';
import type { NextConfig } from "next";

// Host
const HOST = process.env.HOST || '127.0.0.1';

// Read API port from environment variable (set by dev script) or default to 3001
const API_PORT = process.env.API_PORT || '3001';

// Data directory for modules
const DATA_DIR = process.env.SHEET_DELVER_DATA || path.join(process.cwd(), 'data');
const MANAGED_DIR = path.join(process.cwd(), '.managed');
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
      // The generated registry is build input, so keep it project-local even
      // when runtime data is configured outside the Turbopack project root.
      '@data-registry': turboRelative(MANAGED_DIR),
      '@client': path.join(process.cwd(), 'src', 'client'),
      '@shared': path.join(process.cwd(), 'src', 'shared'),
      '@server': path.join(process.cwd(), 'src', 'server'),
      '@core': path.join(process.cwd(), 'src', 'server', 'core'),
      '@app': path.join(process.cwd(), 'src', 'app'),
      '@': path.join(process.cwd(), 'src'),
      '@sheet-delver/sdk': turboRelative(path.join(process.cwd(), 'src', 'shared', 'sdk')),
      // SDK subpath entry points (ADR-0027 decision 2). Turbopack exact aliases do not
      // prefix-match, so each subpath is listed explicitly.
      '@sheet-delver/sdk/react': turboRelative(path.join(process.cwd(), 'src', 'shared', 'sdk', 'entry-react')),
      '@sheet-delver/sdk/server': turboRelative(path.join(process.cwd(), 'src', 'shared', 'sdk', 'entry-server')),
      '@sheet-delver/sdk/testing': turboRelative(path.join(process.cwd(), 'src', 'shared', 'sdk', 'testing')),
    }
  },
  webpack: (config, { isServer }) => {
    config.resolve.alias['@modules'] = [
      path.join(process.cwd(), 'src', 'modules'),
      modulesDir,
    ];
    config.resolve.alias['@local-modules'] = localModulesDir;
    config.resolve.alias['@data-registry'] = MANAGED_DIR;
    config.resolve.alias['@sheet-delver/sdk'] = path.join(process.cwd(), 'src', 'shared', 'sdk');
    // SDK subpath entry points (ADR-0027 decision 2). Exact (`$`) keys win over the bare
    // prefix alias above so `/react` resolves to the entry barrel, not the context file.
    config.resolve.alias['@sheet-delver/sdk/react$'] = path.join(process.cwd(), 'src', 'shared', 'sdk', 'entry-react.ts');
    config.resolve.alias['@sheet-delver/sdk/server$'] = path.join(process.cwd(), 'src', 'shared', 'sdk', 'entry-server.ts');
    config.resolve.alias['@sheet-delver/sdk/testing$'] = path.join(process.cwd(), 'src', 'shared', 'sdk', 'testing.ts');

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
