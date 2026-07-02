import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { build } from 'esbuild';

// 1. Type-check and compile TypeScript to dist/
execSync('tsc', { stdio: 'inherit' });

// 2. Bundle everything into a single CommonJS file.
//    CJS avoids the ESM dynamic-require issues that come from bundling
//    Commander/simple-git with esbuild.
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

await build({
  entryPoints: ['dist/index.js'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'bundle/git-bot.cjs',
  define: {
    PKG_VERSION: JSON.stringify(pkg.version),
  },
});

console.log(`Bundled git-bot v${pkg.version} → bundle/git-bot.cjs`);
