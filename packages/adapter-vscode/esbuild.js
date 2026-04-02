const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// Root of the monorepo
const monorepoRoot = path.resolve(__dirname, '..', '..');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'dist', 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !isWatch,
  metafile: true,
  // Resolve monorepo packages directly from TypeScript source
  alias: {
    '@mobile-copilot/protocol': path.resolve(monorepoRoot, 'packages', 'protocol', 'src', 'index.ts'),
    '@mobile-copilot/adapter-core': path.resolve(monorepoRoot, 'packages', 'adapter-core', 'src', 'index.ts'),
  },
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[watch] Watching for changes...');
  } else {
    const result = await esbuild.build(buildOptions);
    const text = await esbuild.analyzeMetafile(result.metafile);
    console.log(text);
    console.log('[build] Done.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
