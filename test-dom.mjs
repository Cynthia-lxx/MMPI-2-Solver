/**
 * End-to-end smoke test of the page itself, in jsdom.
 *
 *   npm install jsdom   (optional)
 *   node web/test-dom.mjs
 *
 * It loads the built single-file page (web/mmpi2-gui.html -- jsdom cannot run
 * ES modules, so index.html's <script type="module"> is out), picks a target
 * through the real <select>, presses 生成答卷 and checks that the answer grid
 * and the free/locked marking come out.
 */

import { readFileSync } from 'node:fs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('jsdom not installed -- skipping (npm install jsdom)');
  process.exit(0);
}

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

const html = readFileSync(new URL('./mmpi2-gui.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const document = window.document;

// jsdom implements neither of these
window.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = () => {};
if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async () => {} },
    configurable: true,
  });
}

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await wait(100); // the page wires itself up on DOMContentLoaded

/* the page built itself ---------------------------------------------- */
check($('scale-list').querySelectorAll('select').length === 87, '渲染出 87 个量表下拉', `${$('scale-list').querySelectorAll('select').length}`);
check($('scale-list').querySelectorAll('.group').length === 5, '分 5 个量表族');
check($('solve').disabled, '未选目标时生成按钮禁用');

/* pick one target and solve ------------------------------------------- */
const hsSelect = $('scale-list').querySelector('select[data-name="Hs"]');
check(hsSelect.options.length > 5, 'Hs 下拉有可取値', `${hsSelect.options.length} 项`);
hsSelect.value = '70';
hsSelect.dispatchEvent(new window.Event('change'));
check(!$('solve').disabled, '选定目标后按钮可用');

$('solve').click();
check($('status').textContent.includes('计算中'), '点击后先显示计算中', JSON.stringify($('status').textContent));
await wait(4000);

check(!$('results').hidden, '结果区已展开');
check($('status').className.includes('ok'), '状态为命中', JSON.stringify($('status').textContent));
check($('answers').querySelectorAll('.cell').length === 567, '渲染 567 道题', `${$('answers').querySelectorAll('.cell').length}`);

const targetRows = $('target-table').querySelectorAll('tbody tr');
check(targetRows.length === 1 && targetRows[0].textContent.includes('70'), '目标达成表有 Hs 70');

const cells = [...$('answers').querySelectorAll('.cell')];
const free = cells.filter((c) => c.classList.contains('free'));
const locked = cells.filter((c) => c.classList.contains('locked'));
check(free.length + locked.length === 567, '每道题都被标为自由或锁定', `free=${free.length} locked=${locked.length}`);
check(locked.length > 0 && locked.length < 100, 'Hs 的锁定题数量合理', `${locked.length}`);
check($('free-count').textContent.includes('组合'), '显示组合数', JSON.stringify($('free-count').textContent));

/* flipping a free item ------------------------------------------------ */
const cell = free[0];
const before = cell.querySelector('b').textContent;
cell.dispatchEvent(new window.Event('click', { bubbles: true }));
check(cell.querySelector('b').textContent !== before, '点击自由题可切换', `${before} -> ${cell.querySelector('b').textContent}`);
$('status').textContent.includes('完全命中');

/* buttons -------------------------------------------------------------- */
$('shuffle').click();
check($('answers').querySelectorAll('.cell').length === 567, '随机化自由题后网格仍在');
$('copy').click();
await wait(50); // clipboard write is awaited
$('csv').click(); // jsdom prints "navigation not implemented" for the download
check(!$('note').hidden, '复制后有提示', JSON.stringify($('note').textContent));

/* example + clear + search -------------------------------------------- */
$('example').click();
check($('scale-list').querySelectorAll('select').length === 87, '载入示例后列表正常');
const filled = [...$('scale-list').querySelectorAll('select')].filter((s) => s.value !== '').length;
check(filled === 13, '示例填入 13 个基本量表', `${filled}`);
$('solve').click();
await wait(4000);
check($('status').className.includes('ok'), '示例剖面可解', JSON.stringify($('status').textContent));
check($('target-table').querySelectorAll('tbody tr').length === 13, '目标表达成 13 行');

$('search').value = 'BIZ';
$('search').dispatchEvent(new window.Event('input'));
const visible = [...$('scale-list').querySelectorAll('.row')].filter((r) => !r.hidden);
// "BIZ / Bizarre Mentation" plus the Harris-Lingoes "Bizarre Sensory Experiences"
check(
  visible.some((r) => r.dataset.name === 'BIZ') && visible.length === 2,
  '搜索 BIZ 命中 2 项',
  visible.map((r) => r.dataset.name).join(',')
);

$('gender').value = 'female';
$('gender').dispatchEvent(new window.Event('change'));
check($('results').hidden, '切换性别后结果作废');
check($('status').textContent.includes('性别'), '提示重新生成', JSON.stringify($('status').textContent));

console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
