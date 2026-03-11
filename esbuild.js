const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const isWatch = process.argv.includes('--watch');

// Copy mobile-client assets to dist/mobile
function copyMobileClient() {
  const src = path.join(__dirname, 'mobile-client');
  const dest = path.join(__dirname, 'dist', 'mobile');

  if (!fs.existsSync(src)) return;

  fs.mkdirSync(dest, { recursive: true });

  function copyDir(srcDir, destDir) {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  copyDir(src, dest);
  console.log('[build] Copied mobile-client → dist/mobile');
}

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['./src/extension.ts'],
  bundle: true,
  outfile: './dist/extension.js',
  external: ['vscode', 'ws', 'express', 'qrcode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !isWatch,
  metafile: true,
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[watch] Watching for changes...');
    copyMobileClient();

    // Watch mobile-client directory for changes
    const mobileDir = path.join(__dirname, 'mobile-client');
    if (fs.existsSync(mobileDir)) {
      fs.watch(mobileDir, { recursive: true }, () => {
        copyMobileClient();
      });
    }
  } else {
    const result = await esbuild.build(buildOptions);
    const text = await esbuild.analyzeMetafile(result.metafile);
    console.log(text);
    copyMobileClient();
    console.log('[build] Done.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
