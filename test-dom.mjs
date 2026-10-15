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

/* 题干语言 ----------------------------------------------------------- */
$('show-text').checked = true;
$('show-text').dispatchEvent(new window.Event('change'));
$('text-lang').value = 'en';
$('text-lang').dispatchEvent(new window.Event('change'));
check(
  $('answers').querySelector('.cell .q').textContent === 'I like mechanics magazines.',
  '题干语言选英文时网格显示原文',
  JSON.stringify($('answers').querySelector('.cell .q').textContent)
);
$('text-lang').value = 'both';
$('text-lang').dispatchEvent(new window.Event('change'));
const bothCell = $('answers').querySelector('.cell .q');
check(
  bothCell.textContent.includes('I like mechanics magazines.') && bothCell.querySelector('.en'),
  '题干语言选中英对照时两行都在'
);

/* 题库面板 ----------------------------------------------------------- */
const bankRows = [...$('bank-table').querySelectorAll('tbody tr')];
check(bankRows.length === 567, '题库渲染 567 行', `${bankRows.length}`);
check(
  bankRows[0].querySelector('td.orig').textContent === 'I like mechanics magazines.',
  '题库首题是英文原文',
  JSON.stringify(bankRows[0].querySelector('td.orig').textContent)
);
check(bankRows[0].querySelector('td.zh').textContent.length > 4, '题库行带中文译文');
check(/^[TF]$/.test(bankRows[0].querySelector('td.ans').textContent), '题库行带当前回答');
check($('bank-count').textContent.includes('567'), '题库计数正确', JSON.stringify($('bank-count').textContent));

$('bank-search').value = 'mechanics';
$('bank-search').dispatchEvent(new window.Event('input'));
const hits = [...$('bank-table').querySelectorAll('tbody tr')];
check(
  hits.length > 0 && hits.every((r) => r.querySelector('td.orig').textContent.toLowerCase().includes('mechanics')),
  '题库搜索只留命中行',
  `${hits.length} 行`
);
$('bank-search').value = '';
$('bank-search').dispatchEvent(new window.Event('input'));

$('bank-filter').value = 'locked';
$('bank-filter').dispatchEvent(new window.Event('change'));
const lockedRows = $('bank-table').querySelectorAll('tbody tr').length;
check(lockedRows === locked.length, '筛选锁定题与网格一致', `${lockedRows} vs ${locked.length}`);
$('bank-filter').value = 'all';
$('bank-filter').dispatchEvent(new window.Event('change'));

/* flipping a free item ------------------------------------------------ */
// the 题干语言 switches above rebuilt the grid, so re-query instead of reusing `free`
const cell = $('answers').querySelector('.cell.free');
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

/* 预期值模式：区间 --------------------------------------------------- */
$('clear').click();
$('target-mode').value = 'range';
$('target-mode').dispatchEvent(new window.Event('change'));
const loSel = $('scale-list').querySelector('select[data-name="Hs"][data-edge="lo"]');
const hiSel = $('scale-list').querySelector('select[data-name="Hs"][data-edge="hi"]');
check(!!loSel && !!hiSel, '区间模式每行两个下拉（下限 / 上限）');
loSel.value = loSel.options[8].value;
loSel.dispatchEvent(new window.Event('change'));
hiSel.value = hiSel.options[28].value;
hiSel.dispatchEvent(new window.Event('change'));
check(!$('solve').disabled, '区间模式下可求解');

$('solve').click();
await wait(4000);
check($('status').className.includes('ok'), '区间目标可满足', JSON.stringify($('status').textContent));
check($('status').textContent.includes('区间'), '状态说明落在区间内', JSON.stringify($('status').textContent));
const wantCell = $('target-table').querySelector('tbody tr').children[1].textContent;
check(/–|≥|≤/.test(wantCell), '目标列显示区间', JSON.stringify(wantCell));

const slackCells = [...$('answers').querySelectorAll('.cell.slack')];
check(slackCells.length > 0, '区间目标产生「区间内可翻转」题', `${slackCells.length} 道`);
const slackItem = slackCells[0].dataset.item;
const beforeSlack = slackCells[0].querySelector('b').textContent;
slackCells[0].dispatchEvent(new window.Event('click', { bubbles: true }));
const afterSlack = $('answers').querySelector(`.cell[data-item="${slackItem}"] b`).textContent;
check(afterSlack !== beforeSlack, '点击区间内可翻转题可切换', `${beforeSlack} -> ${afterSlack}`);
check($('free-count').textContent.includes('区间内'), '组合数提示含区间内可翻转题', JSON.stringify($('free-count').textContent));

/* 主题切换 ----------------------------------------------------------- */
check(!!$('theme-toggle'), '存在主题切换按钮');
const themeBefore = document.documentElement.getAttribute('data-theme');
$('theme-toggle').click();
const themeAfter = document.documentElement.getAttribute('data-theme');
check(themeBefore !== themeAfter, '点击切换深浅色', `${themeBefore} -> ${themeAfter}`);
check(
  $('theme-toggle').textContent.includes(themeAfter === 'dark' ? '浅色' : '深色'),
  '按钮文字随主题更新'
);
$('theme-toggle').click();
check(document.documentElement.getAttribute('data-theme') === themeBefore, '再次点击回到原主题');

console.log(`\n${failures === 0 ? 'ALL OK' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
