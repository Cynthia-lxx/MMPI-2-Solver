/**
 * End-to-end smoke test of the generic likert scales (PHQ-9 单因子 / HADS 双因子含反向计分),
 * in jsdom。确认「切换量表 -> 选目标 -> 生成答卷 -> 剖面/达成」整条链路对任意 likert 量表都成立。
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
const switchTo = async (id) => {
  const sel = $('scale-switch');
  sel.value = id;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(40);
};
await wait(100);

/* ---- PHQ-9：单总分因子 + 紧凑串导入 ---------------------------------- */
await switchTo('phq9');
check($('scale-list').querySelectorAll('select').length === 1, 'PHQ-9 仅 1 个可设目标（总分）', `${$('scale-list').querySelectorAll('select').length}`);
check($('h-answers-label').textContent.includes('9 题'), 'PHQ-9 题数跟随量表', $('h-answers-label').textContent);

const phqSel = $('scale-list').querySelector('select');
phqSel.value = '20'; // 重度
phqSel.dispatchEvent(new window.Event('change', { bubbles: true }));
$('solve').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(30);
check($('target-table').textContent.includes('总分'), 'PHQ-9 目标达成表含「总分」');
const phqRow = [...$('target-table').querySelectorAll('tbody tr')].find((r) => r.textContent.includes('总分'));
check(phqRow && Math.abs(Number(phqRow.children[2].textContent) - 20) <= 0.5, 'PHQ-9 达成总分 ≈ 20', phqRow && phqRow.children[2].textContent);
check($('answers').querySelectorAll('.cell.slide').length === 9, 'PHQ-9 渲染 9 条滑杆', `${$('answers').querySelectorAll('.cell.slide').length}`);
// 导入紧凑串（全 3 分）应得总分 27、重度
$('import-text').value = '333333333';
$('import-score').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(30);
check($('profile').textContent.includes('27'), 'PHQ-9 导入全 3 分 -> 总分 27', $('profile').textContent.replace(/\s+/g, ' ').slice(0, 60));

/* ---- HADS：双因子且含反向题 --------------------------------------------- */
await switchTo('hads');
const hadsSel = $('scale-list').querySelectorAll('select');
check(hadsSel.length === 2, 'HADS 两个可设目标（焦虑 / 抑郁）', `${hadsSel.length}`);
hadsSel.forEach((sel) => { sel.value = '15'; sel.dispatchEvent(new window.Event('change', { bubbles: true })); });
$('solve').dispatchEvent(new window.Event('click', { bubbles: true }));
await wait(30);
const hadsRows = [...$('target-table').querySelectorAll('tbody tr')];
check(hadsRows.length === 2, 'HADS 目标表两行', `${hadsRows.length}`);
const anxRow = hadsRows.find((r) => r.textContent.includes('焦虑'));
check(anxRow && Math.abs(Number(anxRow.children[2].textContent) - 15) <= 0.5, 'HADS 焦虑达成 ≈ 15', anxRow && anxRow.children[2].textContent);
// 抑郁含反向题：把第 2 题（反向）滑到最高级，抑郁子分不应上升
const depCell = $('answers').querySelector('.cell.slide[data-item="2"]');
const depTrack = depCell.querySelector('.slide-track');
depTrack.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
await wait(30);
const depRowAfter = [...$('target-table').querySelectorAll('tbody tr')].find((r) => r.textContent.includes('抑郁'));
check(depRowAfter && Number(depRowAfter.children[2].textContent) <= 15.01, 'HADS 反向题设最高级 -> 抑郁子分不升', depRowAfter && depRowAfter.children[2].textContent);

console.log(failures === 0 ? 'ALL OK' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
