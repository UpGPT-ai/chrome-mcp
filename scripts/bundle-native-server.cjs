#!/usr/bin/env node
/*
 * Bundle the native server into self-contained CommonJS files so the distributable
 * needs only Node.js 20+ (no npm install, no node_modules).
 *
 *   node scripts/bundle-native-server.cjs <outDir>
 *
 * Entry points keep the same relative layout as the tsc build (cli.js, index.js,
 * mcp/mcp-server-stdio.js, cli/google-cli.js), so every __dirname-relative lookup
 * (stdio-config.json, run_host.*, node_path.txt) keeps working.
 *
 * Native module handling: better-sqlite3 (agent-chat storage only) ships a compiled
 * .node per Node ABI and platform, so it is NOT bundled; a lazy stub is used instead and
 * only the agent-chat feature reports "unavailable". trace-analyzer (chrome-devtools-frontend) is
 * stubbed because it cannot load under plain Node in any build. Everything else is pure JS.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const NS = path.join(ROOT, 'app', 'native-server');
const SRC = path.join(NS, 'src');
const out = path.resolve(process.argv[2] || path.join(NS, 'dist-bundle'));

function loadEsbuild() {
  const tsupPkg = require.resolve('tsup/package.json', { paths: [path.join(ROOT, 'packages', 'shared')] });
  return require(require.resolve('esbuild', { paths: [path.dirname(tsupPkg)] }));
}
const esbuild = loadEsbuild();

const SQLITE_STUB = `
function Database() {
  var real;
  try { real = require('better-sqlite3'); } catch (e) {
    throw new Error('Agent-chat storage is not available in the Node-only package (better-sqlite3 native module not bundled). MCP browser tools are unaffected.');
  }
  return new (Function.prototype.bind.apply(real, [null].concat([].slice.call(arguments))))();
}
module.exports = Database; module.exports.default = Database;
`;

const entries = [
  ['cli.ts', 'cli.js', 0],
  ['index.ts', 'index.js', 0],
  ['mcp/mcp-server-stdio.ts', 'mcp/mcp-server-stdio.js', 1],
  ['cli/google-cli.ts', 'cli/google-cli.js', 1],
];

function plugin(depth) {
  return {
    name: 'native-server-bundle',
    setup(build) {
      // better-sqlite3 -> lazy stub (also covers drizzle-orm's driver import)
      build.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: 'better-sqlite3-stub', namespace: 'stub' }));
      build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: SQLITE_STUB, loader: 'js' }));
      // trace-analyzer needs chrome-devtools-frontend, which ships TypeScript sources that cannot
      // load under plain Node even after npm install (the unbundled build fails the same way).
      build.onResolve({ filter: /(^|\/)trace-analyzer(\.js)?$/ }, () => ({ path: 'trace-analyzer-stub', namespace: 'stub2' }));
      build.onLoad({ filter: /.*/, namespace: 'stub2' }, () => ({
        contents: "exports.analyzeTraceFile = async function () { throw new Error('Offline trace-file analysis is not available in this package.'); };",
        loader: 'js',
      }));
      // Files under src/scripts expect __dirname === <dist>/scripts; make that true wherever
      // the bundle lands (dist/, dist/mcp/, dist/cli/).
      build.onLoad({ filter: /[\\/]src[\\/]scripts[\\/][^\\/]+\.ts$/ }, (args) => {
        let text = fs.readFileSync(args.path, 'utf8');
        const rel = depth === 0 ? "'scripts'" : "'..', 'scripts'";
        text = text.replace(/\b__dirname\b/g, `require('path').join(__dirname, ${rel})`);
        return { contents: text, loader: 'ts', resolveDir: path.dirname(args.path) };
      });
    },
  };
}

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  for (const [src, dst, depth] of entries) {
    await esbuild.build({
      entryPoints: [path.join(SRC, src)],
      outfile: path.join(out, dst),
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      tsconfig: path.join(NS, 'tsconfig.json'),
      alias: { 'chrome-mcp-shared': path.join(ROOT, 'packages', 'shared', 'src', 'index.ts') },
      plugins: [plugin(depth)],
      legalComments: 'none',
      logLevel: 'warning',
      sourcemap: false,
      nodePaths: [path.join(NS, 'node_modules')],
      // import.meta is unused in CJS output; silence warnings for deps that probe it
      logOverride: { 'empty-import-meta': 'silent' },
    });
    console.log('bundled', dst);
  }
})().catch((e) => { console.error(e); process.exit(1); });
