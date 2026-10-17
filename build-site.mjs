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

import { THEME, UI_TEXT, ANIM } from './ui-tokens.js';

const root = dirname(fileURLToPath(import.meta.url));
const SOURCES = [
  'data.js', 'formats.js',
  'likert.js',
  'scl90.data.js', 'scl90.js',
  'phq9.data.js', 'gad7.data.js', 'hads.data.js', 'who5.data.js',
  'mbti_93.data.js', 'mbti_16p_quick.data.js', 'mbti_16p_standard.data.js',
  'mbti_16p_full.data.js', 'mbti_200md.data.js', 'mbti_16p60.data.js',
  'mbti.js', 'mbti_types.js',
  'inverse.js', 'xlsx.js', 'sheet.js', 'ui-tokens.js', 'gui.js',
];
const SRC = 'index.src.html';

// MBTI 数据/引擎拆成独立异步分包：首屏核心包不含 1 万条 KNN 样本（13.5MB），
// 切到 MBTI 时才由 gui.js 动态 import('./mbti.async.js') 拉取。
const MBTI_ASYNC = [
  'mbti_93.data.js', 'mbti_16p_quick.data.js', 'mbti_16p_standard.data.js',
  'mbti_16p_full.data.js', 'mbti_200md.data.js', 'mbti_16p60.data.js',
  'mbti.js', 'mbti_types.js',
];
const CORE_SOURCES = SOURCES.filter((f) => !MBTI_ASYNC.includes(f));

/** Drop ES module syntax so the bundle runs as one classic <script>. */
function stripModule(source) {
  return source
    .replace(/^\s*import\s+[\s\S]*?from\s*['"][^'"]+['"]\s*;?\s*$/gm, '')
    .replace(/^\s*export\s+default\s+.*?;?\s*$/gm, '')
    .replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/^(\s*)export\s+/gm, '$1');
}

const bundle = CORE_SOURCES.map((name) => {
  const code = stripModule(readFileSync(join(root, name), 'utf8')).trim();
  return `/* ===== ${name} ===== */\n${code}`;
}).join('\n\n');

const marker = '<script type="module" src="./gui.js"></script>';
const template = readFileSync(join(root, SRC), 'utf8');
if (!template.includes(marker)) {
  throw new Error(`${SRC}: module script tag not found -- update build-site.mjs`);
}

// ---- 宏常量替换：UX 文案走 {{占位符}}，动效令牌生成 :root 下的 CSS 变量 ----
const macros = { ...THEME, ...UI_TEXT };
const animTokens = [
  '/* 动效令牌：由 ui-tokens.js 的 ANIM 生成，请勿手改 */',
  `    --anim-scale: ${ANIM.scale};`,
  ...Object.entries(ANIM.durations).map(
    ([name, dur]) => `    --anim-${name}: calc(${dur} * var(--anim-scale));`,
  ),
  `    --ease-out: ${ANIM.easeOut};`,
].join('\n');
const expandMacros = (src) => src
  .replace(/\/\*\s*@ANIM_TOKENS@\s*\*\//g, animTokens)
  .replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => (key in macros ? macros[key] : m));

const expanded = expandMacros(template);
const html = expanded.replace(marker, `<script>\n${bundle}\n</script>`);

writeFileSync(join(root, 'index.html'), html);

// 异步分包：薄 re-export 封装，复用已提交的各 MBTI 模块（不重复存储 13.5MB 样本）。
const mbtiWrapper = MBTI_ASYNC.map((f) => `export * from './${f}';`).join('\n') + '\n';
writeFileSync(join(root, 'mbti.async.js'), mbtiWrapper);

const coreKib = (html.length / 1024).toFixed(0);
console.log(`wrote index.html (${coreKib} KiB, core; MBTI excluded) + mbti.async.js (async wrapper over ${MBTI_ASYNC.length} modules)`);
