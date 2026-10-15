// Inline the modular GUI sources into a single self-contained index.html.
//
// ES modules cannot be loaded from file:// (browsers block it as a CORS
// violation), and GitHub Pages only serves index.html -- so the page that
// gets deployed has to be one classic-script file that needs no server and
// no imports. This script reads index.src.html (the modular dev template)
// and the source modules, strips the ES module syntax, and writes index.html.
//
//   node build-site.mjs
//
// Mirrors _port/build_gui.py in the parent MMPI_2_Grader repo.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const SOURCES = ['data.js', 'formats.js', 'scl90.data.js', 'scl90.js', 'inverse.js', 'xlsx.js', 'sheet.js', 'gui.js'];
const SRC = 'index.src.html';

/** Drop ES module syntax so the bundle runs as one classic <script>. */
function stripModule(source) {
  return source
    .replace(/^\s*import\s+[\s\S]*?from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+.*?;?\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^(\s*)export\s+/gm, '$1');
}

const bundle = SOURCES.map((name) => {
  const code = stripModule(readFileSync(join(root, name), 'utf8')).trim();
  return `/* ===== ${name} ===== */\n${code}`;
}).join('\n\n');

const marker = '<script type="module" src="./gui.js"></script>';
const template = readFileSync(join(root, SRC), 'utf8');
if (!template.includes(marker)) {
  throw new Error(`${SRC}: module script tag not found -- update build-site.mjs`);
}
const html = template.replace(marker, `<script>\n${bundle}\n</script>`);

writeFileSync(join(root, 'index.html'), html);
console.log(`wrote index.html (${(html.length / 1024).toFixed(0)} KiB) from ${SOURCES.join(', ')}`);
