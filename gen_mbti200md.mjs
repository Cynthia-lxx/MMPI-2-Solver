import { readFileSync, writeFileSync } from 'fs';

const SRC = 'C:/Users/wjz-s/Downloads/MMPI_2_Grader-master/MMPI_2_Grader-master/MBTI_Test_16Personalities-main/权威完整版200道MBTI人格测试题.md';
const text = readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

// 段标题形如：## 第一部分：外向（E）vs 内向（I）（共50题）
const sectionRe = /（([A-Z])）.*?（([A-Z])）/;
const itemRe = /^\s*\d+[.、)]\s*(.+)$/;

let cur = null;
const items = [];
for (const line of lines) {
  const sm = line.match(sectionRe);
  if (sm && /第.+部分/.test(line)) {
    cur = { a: sm[1], b: sm[2] };
    continue;
  }
  if (!cur) continue;
  const im = line.match(itemRe);
  if (im) {
    const body = im[1].trim();
    // 仅收录带 A/B 选项标记的行（真正的题目），排除说明段落的编号行
    if (body.length > 0 && /[（(]\s*[AB]\s*[)）]/.test(body)) {
      // 拆出「题干（A）A文本 /（B）B文本」
      const aIdx = body.indexOf('（A）');
      const bIdx = body.indexOf('（B）');
      if (aIdx >= 0 && bIdx > aIdx) {
        // （A）标记 A 选项结束：其前全文即 A 选项文本；（A）后到（B）前为 B 选项文本
        const aText = body.slice(0, aIdx).trim();
        let bText = body.slice(aIdx + 3, bIdx).trim();
        bText = bText.replace(/^[\s/／]+/, '').replace(/[\s/／]+$/, '');
        items.push({ a: cur.a, b: cur.b, stem: '', zhA: aText, zhB: bText });
      } else {
        items.push({ a: cur.a, b: cur.b, stem: body, zhA: body, zhB: '' });
      }
    }
  }
}

const itemOptions = items.map((x) => [x.a, x.b]);
const zh = items.map((x) => x.stem || x.zhA);
const zhA = items.map((x) => x.zhA);
const zhB = items.map((x) => x.zhB);
const data = {
  id: 'mbti200md',
  name: 'MBTI 200 题（权威完整版）',
  blurb: '选择目标人格类型，反推出一份能命中该类型的作答；或直接导入、编辑并评分。',
  nItems: items.length,
  itemOptions,
  items: { zh, zhA, zhB },
  scales: [
    { name: 'EI', pair: ['E', 'I'], tieThreshold: 5 },
    { name: 'SN', pair: ['S', 'N'], tieThreshold: 5 },
    { name: 'TF', pair: ['T', 'F'], tieThreshold: 5 },
    { name: 'JP', pair: ['J', 'P'], tieThreshold: 5 },
  ],
  types: null,
};

writeFileSync(
  'mbti_200md.data.js',
  '// AUTO-GENERATED from 权威完整版200道MBTI人格测试题.md\n' +
  'import { MBTI_TYPES_16 } from "./mbti_types.js";\n\n' +
  'export const MBTI200MD_DATA = ' + JSON.stringify(data, null, 2) + ';\n'
);
console.log('parsed', items.length, 'items; sample dims:',
  itemOptions.slice(0, 3).map((o) => o.join('')).join(' '), '...',
  itemOptions.slice(50, 53).map((o) => o.join('')).join(' '));
