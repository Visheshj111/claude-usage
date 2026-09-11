import * as esbuild from 'esbuild';
import { cpSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, 'src');
const dist = resolve(__dirname, 'dist');

const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');

const base = {
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  minify: false,
  sourcemap: isDev,
};

const entries = [
  { in: resolve(src, 'entry-content.ts'), out: 'content' },
  { in: resolve(src, 'entry-background.ts'), out: 'background' },
  { in: resolve(src, 'entry-injector.ts'), out: 'injector' },
  { in: resolve(src, 'popup/popup.ts'), out: 'popup/popup' },
  { in: resolve(src, 'options/options.ts'), out: 'options/options' },
  { in: resolve(src, 'dashboard/dashboard.ts'), out: 'dashboard/dashboard' },
  { in: resolve(src, 'theme-boot.ts'), out: 'theme-boot' },
];

function copyStatic(dir) {
  const srcDir = resolve(src, dir);
  const dstDir = resolve(dist, dir);
  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.js' || ext === '.ts' || ext === '.tsx') continue;
      const srcFile = resolve(srcDir, entry.name);
      const dstFile = resolve(dstDir, entry.name);
      try { cpSync(srcFile, dstFile); } catch {}
    }
  } catch {}
}

async function build() {
  rmSync(dist, { recursive: true, force: true });

  for (const entry of entries) {
    const ctx = await esbuild.context({
      ...base,
      entryPoints: [entry.in],
      outfile: resolve(dist, `${entry.out}.js`),
    });

    if (isWatch) {
      await ctx.watch();
      console.log(`watching ${entry.out}...`);
    } else {
      await ctx.rebuild();
      await ctx.dispose();
      console.log(`built dist/${entry.out}.js`);
    }
  }

  const staticDirs = ['popup', 'options', 'inpage', 'dashboard'];
  for (const dir of staticDirs) {
    copyStatic(dir);
  }

  try { cpSync(resolve(__dirname, 'src', 'watcher.js'), resolve(dist, 'watcher.js')); } catch {}
  try { cpSync(resolve(__dirname, 'icons'), resolve(dist, 'icons'), { recursive: true }); } catch {}
  try {
    const manifestPath = resolve(__dirname, 'manifest.json');
    let manifestStr = readFileSync(manifestPath, 'utf8');
    manifestStr = manifestStr.replace(/"dist\//g, '"');
    writeFileSync(resolve(dist, 'manifest.json'), manifestStr);
  } catch (e) {
    console.error("Failed to copy manifest:", e);
  }

  console.log('build complete');
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
