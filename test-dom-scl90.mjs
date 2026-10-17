/**
 * End-to-end smoke test of the SCL-90 scale switch, in jsdom.
 * Mirrors test-dom.mjs but drives the 「量表」switcher instead of MMPI-2.
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

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true });
const { window } = dom;
const document = window.document;
window.URL.createObjectURL = () => 'blob:stub';
window.URL.revokeObjectURL = () => {};

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(100);

check(!!$('scale-switch'), '存在量表切换下拉');
check($('scale-list').querySelectorAll('select').length === 87, '默认是 MMPI-2（87 个量表）', `${$('scale-list').querySelectorAll('select').length}`);

/* 切换到 SCL-90 -------------------------------------------------------- */
$('scale-switch').value = 'scl90';
$('scale-switch').dispatchEvent(new window.Event('change'));
await wait(50);

check($('scale-list').querySelectorAll('select').length === 10, 'SCL-90 列出 10 个可设目标因子', `${$('scale-list').querySelectorAll('select').length}`);
check($('gender').closest('.mmpi2-only') !== null && window.getComputedStyle($('gender').closest('.mmpi2-only')).display === 'none', 'MMPI-2 专属控件被隐藏');
check($('h-answers').textContent.includes('90'), '结果标题切换为 90 题', JSON.stringify($('h-answers').textContent));

/* 选定一个因子目标并求解 ---------------------------------------------- */
const depSel = $('scale-list').querySelector('select[data-name="抑郁"]');
check(!!depSel, '存在「抑郁」因子下拉');
check(depSel.options.length >= 3, '抑郁下拉有严重度预设', `${depSel.options.length} 项`);
const targetVal = '4.2'; // 偏重~严重 的代表均分
depSel.value = targetVal;
depSel.dispatchEvent(new window.Event('change'));
check(!$('solve').disabled, '选定目标后生成按钮可用');

$('solve').click();
await wait(100);

check(!$('results').hidden, '结果区展开');
check($('status').className.includes('ok'), '状态为命中', JSON.stringify($('status').textContent));
check($('answers').querySelectorAll('.cell').length === 90, '渲染 90 道 SCL-90 题', `${$('answers').querySelectorAll('.cell').length}`);

/* 每道题是多级滑杆，而非 T/F 或按钮 ---------------------------------- */
const firstCell = $('answers').querySelector('.cell');
check(firstCell.classList.contains('slide'), '答题单元为滑杆', firstCell.className);
const firstTrack = firstCell.querySelector('.slide-track');
check(!!firstTrack, '存在滑轨');
check(firstTrack.dataset.n === '5', '滑轨按 5 个选项分块', firstTrack.dataset.n);
check(!!firstCell.querySelector('.slide-mark'), '滑轨标出可行区间');
check(/linear-gradient/.test(firstTrack.getAttribute('style') || ''), '滑轨背景为分块渐变');

/* 目标达成表含抑郁且达成均分≈4.2 -------------------------------------- */
const tRows = $('target-table').querySelectorAll('tbody tr');
const depRow = [...tRows].find((r) => r.textContent.includes('抑郁'));
check(!!depRow, '目标达成表含「抑郁」');
const depMean = Number(depRow.children[2].textContent);
check(Math.abs(depMean - 4.2) <= 0.08, '抑郁达成均分 ≈ 4.2', `${depMean}`);

/* 完整剖面 12 行 ------------------------------------------------------ */
const pRows = $('profile').querySelectorAll('tbody tr');
check(pRows.length === 12, '完整剖面 12 个维度', `${pRows.length}`);

/* 键盘调整滑杆，同因子重分配后目标均值保持不变 ------------------------ */
const depCell = $('answers').querySelector('.cell[data-item="14"]'); // 第 14 题属抑郁
const depTrack = depCell.querySelector('.slide-track');
const before = Number(depTrack.getAttribute('aria-valuenow'));
depTrack.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
await wait(30);
// 提交会重建网格，需重新查询
const depCell2 = $('answers').querySelector('.cell[data-item="14"]');
const after = Number(depCell2.querySelector('.slide-track').getAttribute('aria-valuenow'));
check(after !== before, '键盘调整滑杆改变答案', `${before} -> ${after}`);
const depRowAfter = [...$('target-table').querySelectorAll('tbody tr')].find((r) => r.textContent.includes('抑郁'));
check(!!depRowAfter, '改答案后抑郁行仍在');
check(Math.abs(Number(depRowAfter.children[2].textContent) - 4.2) <= 0.08, '重分配后抑郁均分仍 ≈ 4.2');
const marks = [...$('answers').querySelectorAll('.slide-mark')];
check(marks.length === 90, '90 题都标出了可行区间', `${marks.length}`);

/* 题库状态显示区间/锁定，而非一律「自由」 ------------------------------ */
const bankStatuses = [...$('bank-table').querySelectorAll('tbody tr')]
  .map((r) => (r.children[4] ? r.children[4].textContent : ''))
  .filter(Boolean);
check(bankStatuses.some((t) => /可调|锁定/.test(t)), '题库状态显示区间/锁定', bankStatuses.slice(0, 3).join(' | '));
check(!bankStatuses.some((t) => t === '自由'), 'SCL-90 题库不再显示「自由」');

console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
