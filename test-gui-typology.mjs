/**
 * e2e smoke test for the MBTI typology integration in gui.js.
 *
 *   node test-gui-typology.mjs
 *
 * Loads the real gui.js against a jsdom copy of index.src.html (minus the
 * module <script>), switches through every MBTI scale, picks a target type,
 * generates an answer sheet, flips a cell, and round-trips an import.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync('./index.src.html', 'utf8')
  .replace(/<script type="module"[^>]*><\/script>/, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.localStorage = dom.window.localStorage;

await import('./gui.js');
const { document } = globalThis;
const win = dom.window;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const MBTI_IDS = ['mbti93', 'mbti16p28', 'mbti16p93', 'mbti16p200', 'mbti200md', 'mbti16p60'];
const { MBTI93_DATA } = await import('./mbti_93.data.js');
const { MBTI16P_QUICK_DATA } = await import('./mbti_16p_quick.data.js');
const { MBTI16P_STANDARD_DATA } = await import('./mbti_16p_standard.data.js');
const { MBTI16P_FULL_DATA } = await import('./mbti_16p_full.data.js');
const { MBTI200MD_DATA } = await import('./mbti_200md.data.js');
const { MBTI16P60_DATA } = await import('./mbti_16p60.data.js');
const NITEMS = {
  mbti93: MBTI93_DATA.nItems,
  mbti16p28: MBTI16P_QUICK_DATA.nItems,
  mbti16p93: MBTI16P_STANDARD_DATA.nItems,
  mbti16p200: MBTI16P_FULL_DATA.nItems,
  mbti200md: MBTI200MD_DATA.nItems,
  mbti16p60: MBTI16P60_DATA.nItems,
};

const scaleSwitch = document.getElementById('scale-switch');
const setScale = (id) => {
  scaleSwitch.value = id;
  scaleSwitch.dispatchEvent(new win.Event('change'));
};
const countCells = (html) => (html.match(/class="cell typ/g) || []).length;

/* 1. 每个 MBTI 题本：切到 → 选 INTJ → 生成 → 检查格数与达成状态 */
for (const id of MBTI_IDS) {
  setScale(id);
  const typeSel = document.querySelector('#typ-type');
  check(!!typeSel, `${id} 渲染了 typology 目标选择器`);
  typeSel.value = 'INTJ';
  typeSel.dispatchEvent(new win.Event('change'));
  document.getElementById('solve').click();
  await wait(150);
  const ans = document.getElementById('answers').innerHTML;
  const n = countCells(ans);
  check(n === NITEMS[id], `${id} 生成 ${NITEMS[id]} 个作答格`, `cells=${n}`);
  check(document.getElementById('status').className.includes('ok'), `${id} 状态为达成`);
  check(
    document.getElementById('profile').innerHTML.includes('INTJ'),
    `${id} 结果展示类型 INTJ`
  );
}

/* 2. 翻转一格（在 mbti93 下）：不应抛错且仍渲染 */
setScale('mbti93');
const t = document.querySelector('#typ-type');
t.value = 'INTP';
t.dispatchEvent(new win.Event('change'));
document.getElementById('solve').click();
await wait(150);
const before = countCells(document.getElementById('answers').innerHTML);
const cell = document.querySelector('#answers .cell');
cell.dispatchEvent(new win.Event('click', { bubbles: true }));
const after = countCells(document.getElementById('answers').innerHTML);
check(after === before && after > 0, '翻转一格后仍正常渲染', `cells=${after}`);

/* 3. 导入 round-trip：mbti93 的 INTJ 作答串 → 评分仍为 INTJ */
setScale('mbti93');
const { mbtiSolve } = await import('./mbti.js');
const sol = mbtiSolve(MBTI93_DATA, 'INTJ');
const str = sol.answers.map((a) => (a ? 'B' : 'A')).join('');
const importText = document.getElementById('import-text');
importText.value = str;
document.getElementById('import-score').click();
await wait(80);
check(
  document.getElementById('profile').innerHTML.includes('INTJ'),
  '导入 INTJ 作答串后评分仍为 INTJ',
  `len=${str.length}`
);

console.log(failures === 0 ? 'ALL OK (typology e2e)' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
