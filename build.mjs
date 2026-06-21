import * as esbuild from 'esbuild';
import { cpSync, rmSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, 'src');
const dist = resolve(__dirname, 'dist');

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const base = {
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  minify: false,
  sourcemap: false,
};

const entries = [
  { in: resolve(src, 'entry-content.ts'), out: 'content' },
  { in: resolve(src, 'entry-background.ts'), out: 'background' },
  { in: resolve(src, 'entry-injector.ts'), out: 'injector' },
  // Static UI pages (now TypeScript)
  { in: resolve(src, 'popup/popup.ts'), out: 'popup/popup' },
  { in: resolve(src, 'options/options.ts'), out: 'options/options' },
  { in: resolve(src, 'dashboard/dashboard.ts'), out: 'dashboard/dashboard' },
  { in: resolve(src, 'theme-boot.ts'), out: 'theme-boot' },
];

/** Copy only non-JS/TS files from a directory */
function copyStatic(dir) {
  const srcDir = resolve(src, dir);
  const dstDir = resolve(dist, dir);
  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Skip descendants
        continue;
      }
      const ext = extname(entry.name).toLowerCase();
      if (ext === '.js' || ext === '.ts' || ext === '.tsx') continue;
      const srcFile = resolve(srcDir, entry.name);
      const dstFile = resolve(dstDir, entry.name);
      try { cpSync(srcFile, dstFile); } catch {}
    }
  } catch {}
}

async function build() {
  // Clean dist
  rmSync(dist, { recursive: true, force: true });

  // Bundle TS entries
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

  // Copy static assets (HTML, CSS, icons)
  const staticDirs = ['popup', 'options', 'inpage', 'dashboard'];
  for (const dir of staticDirs) {
    copyStatic(dir);
  }

  // Copy watcher.js (page-world fetch interceptor, loaded via script.src to bypass CSP)
  try { cpSync(resolve(__dirname, 'src', 'watcher.js'), resolve(dist, 'watcher.js')); } catch {}

  // Copy icons
  try { cpSync(resolve(__dirname, 'icons'), resolve(dist, 'icons'), { recursive: true }); } catch {}

  console.log('build complete');
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
