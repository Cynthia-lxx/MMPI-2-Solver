import { readFileSync, writeFileSync } from 'fs';

const ROOT = 'C:/Users/wjz-s/Downloads/MMPI_2_Grader-master/MMPI_2_Grader-master';
const CSV = ROOT + '/KNN-Implementation-Numpy-master/subset_16P.csv';

/** 引号感知的 CSV 解析（支持字段内逗号与换行、双引号转义 ""）。 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false;
      } else field += c;
    } else if (c === '"') {
      q = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// 基于题面语义标注的维度 + 极性（第二字母为预期倾向）
const ANNOT = {
  1: ['EI', 'E'], 2: ['SN', 'N'], 3: ['TF', 'F'], 4: ['JP', 'J'], 5: ['TF', 'T'],
  6: ['TF', 'T'], 7: ['EI', 'I'], 8: ['EI', 'I'], 9: ['JP', 'J'], 10: ['TF', 'F'],
  11: ['JP', 'J'], 12: ['TF', 'F'], 13: ['EI', 'E'], 14: ['SN', 'S'], 15: ['TF', 'T'],
  16: ['JP', 'P'], 17: ['EI', 'E'], 18: ['EI', 'E'], 19: ['SN', 'N'], 20: ['TF', 'F'],
  21: ['SN', 'N'], 22: ['TF', 'F'], 23: ['EI', 'I'], 24: ['SN', 'S'], 25: ['TF', 'T'],
  26: ['JP', 'J'], 27: ['TF', 'T'], 28: ['EI', 'I'], 29: ['TF', 'F'], 30: ['TF', 'T'],
  31: ['JP', 'P'], 32: ['SN', 'N'], 33: ['SN', 'N'], 34: ['SN', 'N'], 35: ['EI', 'E'],
  36: ['SN', 'S'], 37: ['TF', 'F'], 38: ['JP', 'P'], 39: ['JP', 'J'], 40: ['EI', 'E'],
  41: ['EI', 'E'], 42: ['TF', 'F'], 43: ['TF', 'T'], 44: ['JP', 'J'], 45: ['TF', 'T'],
  46: ['EI', 'I'], 47: ['SN', 'N'], 48: ['EI', 'E'], 49: ['EI', 'E'], 50: ['JP', 'J'],
  51: ['JP', 'J'], 52: ['TF', 'F'], 53: ['SN', 'N'], 54: ['TF', 'F'], 55: ['TF', 'F'],
  56: ['TF', 'F'], 57: ['JP', 'P'], 58: ['TF', 'F'], 59: ['TF', 'F'], 60: ['EI', 'I'],
};

const rows = parseCSV(readFileSync(CSV, 'utf8'));
const header = rows[0];
const items = [];
for (let i = 1; i <= 60; i += 1) items.push(header[i]);
const itemOptions = [];
for (let i = 1; i <= 60; i += 1) {
  const [dim, pol] = ANNOT[i];
  const pair = { EI: ['E', 'I'], SN: ['S', 'N'], TF: ['T', 'F'], JP: ['J', 'P'] }[dim];
  const other = pair[0] === pol ? pair[1] : pair[0];
  itemOptions.push([pol, other]); // A(+)=pol, B(-)=other
}

const samples = [];
for (let r = 1; r < rows.length; r += 1) {
  const cols = rows[r];
  if (cols.length < 62) continue;
  const ans = [];
  for (let i = 1; i <= 60; i += 1) ans.push(Number(cols[i]) > 0 ? 0 : 1);
  samples.push({ ans, label: cols[61] });
}

const data = {
  id: 'mbti16p60',
  name: '16personalities 60 题（KNN 数据集）',
  blurb: '源自 16personalities 官网 60 题标准题库；附真实标注样本，可作反推/验证基准。',
  nItems: 60,
  itemOptions,
  items: { zh: items, en: items },
  scales: [
    { name: 'EI', pair: ['E', 'I'], tieThreshold: 0 },
    { name: 'SN', pair: ['S', 'N'], tieThreshold: 0 },
    { name: 'TF', pair: ['T', 'F'], tieThreshold: 0 },
    { name: 'JP', pair: ['J', 'P'], tieThreshold: 0 },
  ],
  types: null,
  samples,
};

writeFileSync(
  'mbti_16p60.data.js',
  '// AUTO-GENERATED from subset_16P.csv (with manual dimension/polarity annotation)\n' +
  'export const MBTI16P60_DATA = ' + JSON.stringify(data, null, 2) + ';\n'
);
console.log('generated mbti_16p60.data.js:', data.nItems, 'items,', samples.length, 'labeled samples; header cols', header.length);
