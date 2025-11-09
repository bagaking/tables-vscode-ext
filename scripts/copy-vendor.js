/*
 Copies runtime webview vendor assets into media/vendor so packaging does not depend on node_modules at runtime.
*/
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function copyFile(src, dest) {
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
  console.log(`[copy-vendor] ${src} -> ${dest}`);
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const nm = (p) => path.join(root, 'node_modules', p);
  const out = (p) => path.join(root, 'media', 'vendor', p);

  const tasks = [
    [nm('ag-grid-community/styles/ag-grid.css'), out('ag-grid.css')],
    [nm('ag-grid-community/styles/ag-theme-quartz.css'), out('ag-theme-quartz.css')],
    [nm('ag-grid-community/dist/ag-grid-community.min.js'), out('ag-grid-community.min.js')],
    [nm('papaparse/papaparse.min.js'), out('papaparse.min.js')]
  ];

  for (const [src, dest] of tasks) {
    if (!fs.existsSync(src)) {
      console.error(`[copy-vendor] Missing: ${src}`);
      process.exitCode = 1;
      continue;
    }
    await copyFile(src, dest);
  }
}

main().catch((err) => {
  console.error('[copy-vendor] Failed:', err);
  process.exit(1);
});

