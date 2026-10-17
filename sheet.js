/**
 * Everything the "export" panel produces: the tabular views of a solved answer
 * sheet, their item texts and Chinese norms, and the serialisers that turn
 * them into xlsx / csv / tsv / markdown / html / json.
 *
 * DOM-free on purpose -- web/test-gui.mjs drives these under Node.
 */

import { MMPI2_DATA } from './data.js';
import { sheetsToXlsx } from './xlsx.js';
import { itemFormatDesc, levelCount } from './formats.js';

/* -- item text and Chinese norms -------------------------------------- */

/** Item text for a 1-based item number: {en, zh}. */
export function itemText(item, data = MMPI2_DATA) {
  return { en: data.items.en[item - 1], zh: data.items.zh[item - 1] };
}

/** 某题作答的展示文本：TF 为 T/F，多级量表为「1 起的级别序号」。 */
export function answerLabel(data, item, answer) {
  if (answer === null || answer === undefined) return '';
  const desc = itemFormatDesc(data, item);
  if (desc.type === 'binary') return answer ? 'T' : 'F';
  return String(Number(answer) + 1);
}

/**
 * US T -> approximate Chinese T, or null when the scale has no Chinese norm.
 *
 * Only 29 of the 87 scales have published parameters, and the conversion is a
 * two-parameter affine approximation -- see mmpi2/cn_norms.py.  Never invent a
 * number for the rest.
 */
export function cnT(scale, tUS, isMale = true, data = MMPI2_DATA) {
  const norm = data.cnNorms.norm[scale];
  if (!norm || typeof tUS !== 'number' || !Number.isFinite(tUS)) return null;
  const offset = isMale ? 0 : 2;
  const value = 50 + (tUS - norm.tUS[offset]) * 10 / norm.tUS[offset + 1];
  return Math.round(Math.max(data.cnNorms.floor, Math.min(data.cnNorms.ceil, value)));
}

/** US T needed to reach the Chinese cut-off (default 60), or null. */
export function usTForCn60(scale, isMale = true, data = MMPI2_DATA) {
  const norm = data.cnNorms.norm[scale];
  if (!norm) return null;
  const offset = isMale ? 0 : 2;
  return norm.tUS[offset] + norm.tUS[offset + 1];
}

/* -- which scales are K-corrected -------------------------------------- */

export function kNotes(data = MMPI2_DATA) {
  const notes = new Map();
  for (const [y, coef] of Object.entries(data.kCorrections || {})) {
    notes.set(data.abbreviations[0][Number(y)], `+${coef}K`);
  }
  return notes;
}

/* -- the four tables --------------------------------------------------- */

export function answerSheet(plan, options = {}) {
  const { withEnglish = true, withLockInfo = true, data = MMPI2_DATA } = options;
  const header = ['题号', '中文题干', '回答'];
  if (withEnglish) header.push('英文题干');
  if (withLockInfo) header.push('状态', '影响的量表');

  const rows = [header];
  for (let item = 1; item <= data.nItems; item += 1) {
    const free = plan.freedom[item];
    const text = itemText(item, data);
    const row = [item, text.zh, answerLabel(data, item, plan.answers[item - 1])];
    if (withEnglish) row.push(text.en);
    if (withLockInfo) {
      let status = free ? '自由' : '锁定';
      let affects = free ? '' : (plan.lockReason.get(item) || []).join('、');
      // SCL-90：状态改为可行区间（锁定=单值）
      if (data.scale === 'scl90' && plan.itemBounds && plan.itemBounds[item]) {
        const b = plan.itemBounds[item];
        status = b.lo < b.hi ? `区间 ${b.lo + 1}–${b.hi + 1}` : `锁定 ${b.lo + 1}`;
        affects = '';
      }
      row.push(status);
      row.push(affects);
    }
    rows.push(row);
  }
  return {
    name: '答题表',
    rows,
    widths: withEnglish ? [6, 52, 6, 52, 8, 22] : [6, 60, 6, 8, 22],
  };
}

/** 通用 likert 量表因子剖面表：均分/总分 + 临床解释（无 T 分概念）。 */
export function likertProfileSheet(plan, data) {
  const factors = (plan.profile && plan.profile.factors) || {};
  const diagnoses = (plan.profile && plan.profile.diagnoses) || {};
  const rows = [['因子', '均分/总分', '解释']];
  for (const f of data.scales) {
    const metric = f.bandMetric || 'mean';
    const val =
      f.bind[0] === 0 && f.type === 'sum'
        ? plan.profile.total
        : f.bind[0] === 0
          ? plan.profile.totalMean.toFixed(2)
          : (metric === 'sum' ? factors[f.name].raw : factors[f.name].mean).toFixed(2);
    const sev = diagnoses[f.name] ? diagnoses[f.name].severity : '';
    rows.push([f.name, val, sev]);
  }
  return { name: '因子剖面', rows, widths: [12, 12, 22] };
}

/** 通用 likert 量表目标达成表：各因子目标 vs 达成 + 偏差。 */
export function likertTargetSheet(plan, data) {
  const rows = [['因子', '目标', '达成', '偏差']];
  for (const name of Object.keys(plan.target || {})) {
    const want = Number(plan.target[name]);
    const got = Number(plan.achieved[name]);
    const gap = got - want;
    rows.push([name, want.toFixed(2), got.toFixed(2), (gap >= 0 ? '+' : '') + gap.toFixed(2)]);
  }
  return { name: '因子均分达成', rows, widths: [12, 12, 12, 10] };
}

export function profileSheet(plan, options = {}) {
  const { isMale = true, data = MMPI2_DATA } = options;
  const notes = kNotes(data);
  const rows = [['量表', '族', '名称', '原始分', 'K 校正', '美国 T', '近似中国 T', '达中国 60 界']];
  for (const slot of data.scales) {
    const tUS = (plan.profile || {})[slot.name];
    const raw = (plan.rawByName || {})[slot.name];
    const cn = cnT(slot.name, tUS, isMale, data);
    rows.push([
      slot.name,
      data.families[slot.family],
      slot.fullName,
      raw === undefined ? null : raw,
      notes.get(slot.name) || '',
      tUS === undefined ? null : tUS,
      cn === null ? '' : cn,
      cn === null ? '无中国常模' : (cn >= data.cnNorms.cutoffCN ? '是' : '否'),
    ]);
  }
  return { name: '量表剖面', rows, widths: [10, 16, 30, 9, 9, 9, 12, 14] };
}

export function targetSheet(plan, options = {}) {
  const { isMale = true, data = MMPI2_DATA } = options;
  const rows = [['量表', '目标', '达成（美国 T）', '近似中国 T', '偏差', '中国 60 界对应美国 T']];
  for (const name of Object.keys(plan.target || {})) {
    const got = plan.achieved[name];
    const cn = cnT(name, got, isMale, data);
    const reference = usTForCn60(name, isMale, data);
    const gap = plan.residual[name];
    rows.push([
      name,
      plan.requested[name] === plan.target[name]
        ? plan.target[name]
        : `${plan.requested[name]} → ${plan.target[name]}`,
      got,
      cn === null ? '' : cn,
      gap === 0 ? 0 : (gap > 0 ? `+${gap}` : gap),
      reference === null ? '' : Number(reference.toFixed(1)),
    ]);
  }
  return { name: '目标达成', rows, widths: [10, 12, 16, 12, 8, 22] };
}

/** Printable blank answer sheet: hand it to a person, type their answers in. */
export function blankTemplate(options = {}) {
  const { withEnglish = true, data = MMPI2_DATA } = options;
  const header = ['题号', '中文题干', '回答'];
  if (withEnglish) header.push('英文题干');
  const rows = [header];
  for (let item = 1; item <= data.nItems; item += 1) {
    const text = itemText(item, data);
    const row = [item, text.zh, ''];
    if (withEnglish) row.push(text.en);
    rows.push(row);
  }
  return { name: '空白答题模板', rows, widths: withEnglish ? [6, 60, 12, 60] : [6, 72, 12] };
}

export const EXPORT_CONTENTS = [
  { id: 'answers', label: '答题表（567 题 × 题干 / 回答 / 是否自由）' },
  { id: 'profile', label: '量表剖面（87 个量表的原始分 / 美国 T / 中国 T）' },
  { id: 'targets', label: '目标达成（偏差与折算）' },
  { id: 'template', label: '空白答题模板（供真人作答）' },
];

export function buildSheets(plan, options = {}) {
  const { content = ['answers'], withEnglish = true, withLockInfo = true, data = MMPI2_DATA } = options;
  const isMale = plan ? plan.isMale : true;
  const out = [];
  for (const id of content) {
    if (id === 'answers' && plan) out.push(answerSheet(plan, { withEnglish, withLockInfo, data }));
    if (id === 'profile' && plan) {
      out.push(data.id === 'mmpi2'
        ? profileSheet(plan, { isMale, data })
        : likertProfileSheet(plan, data));
    }
    if (id === 'targets' && plan) {
      out.push(data.id === 'mmpi2'
        ? targetSheet(plan, { isMale, data })
        : likertTargetSheet(plan, data));
    }
    if (id === 'template') out.push(blankTemplate({ withEnglish, data }));
  }
  return out;
}

/* -- serialisers -------------------------------------------------------- */

function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Excel on Windows needs the BOM, otherwise UTF-8 Chinese turns to mojibake. */
export function toCsv(rows, options = {}) {
  const { bom = true } = options;
  const body = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  return (bom ? '﻿' : '') + body + '\r\n';
}

export function toTsv(rows) {
  const escape = (value) =>
    String(value === null || value === undefined ? '' : value).replace(/[\t\r\n]/g, ' ');
  return rows.map((row) => row.map(escape).join('\t')).join('\r\n') + '\r\n';
}

export function toMarkdown(rows) {
  if (!rows.length) return '';
  const head = rows[0];
  const lines = [
    `| ${head.map((c) => String(c ?? '')).join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows.slice(1)) lines.push(`| ${row.map((c) => String(c ?? '')).join(' | ')} |`);
  return lines.join('\n') + '\n';
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function toHtml(sheets, options = {}) {
  const { title = 'MMPI-2 导出' } = options;
  const blocks = sheets
    .map((sheet) => {
      const [head, ...body] = sheet.rows;
      if (!head) return '';
      const rows = body
        .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
        .join('\n');
      return (
        `<h2>${escapeHtml(sheet.name)}</h2>\n<table>\n<thead><tr>` +
        head.map((c) => `<th>${escapeHtml(c)}</th>`).join('') +
        `</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`
      );
    })
    .join('\n');
  return (
    '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title>\n<style>` +
    'body{font-family:"Microsoft YaHei",system-ui,sans-serif;font-size:13px;margin:24px}' +
    'table{border-collapse:collapse;width:100%;margin-bottom:28px}' +
    'th,td{border:1px solid #ccd;padding:4px 7px;text-align:left;vertical-align:top}' +
    'th{background:#eef2f7;position:sticky;top:0}' +
    '</style></head><body>\n' +
    `<h1>${escapeHtml(title)}</h1>\n${blocks}\n</body></html>\n`
  );
}

export function toJson(sheets) {
  const out = {};
  for (const sheet of sheets) {
    const [head, ...body] = sheet.rows;
    const keys = (head || []).map((key, i) => String(key || `col${i + 1}`));
    out[sheet.name] = body.map((row) => {
      const record = {};
      keys.forEach((key, i) => {
        record[key] = row[i] === undefined ? null : row[i];
      });
      return record;
    });
  }
  return JSON.stringify(out, null, 2) + '\n';
}

export const EXPORT_FORMATS = [
  { id: 'xlsx', label: 'Excel 工作簿 (.xlsx)', ext: 'xlsx', multi: true },
  { id: 'csv', label: 'CSV（Excel 可直接打开，含 BOM）', ext: 'csv' },
  { id: 'tsv', label: 'TSV（制表符）', ext: 'tsv' },
  { id: 'html', label: 'HTML 表格', ext: 'html', multi: true },
  { id: 'json', label: 'JSON', ext: 'json', multi: true },
  { id: 'md', label: 'Markdown 表格', ext: 'md' },
];

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv;charset=utf-8',
  tsv: 'text/tab-separated-values;charset=utf-8',
  html: 'text/html;charset=utf-8',
  json: 'application/json;charset=utf-8',
  md: 'text/markdown;charset=utf-8',
};

/**
 * @returns {{filename: string, mime: string, body: Uint8Array|string, binary: boolean}}
 */
export function serialize(sheets, format = 'xlsx', options = {}) {
  const { basename = 'mmpi2-export' } = options;
  const spec = EXPORT_FORMATS.find((f) => f.id === format) || EXPORT_FORMATS[0];
  let body;
  if (spec.id === 'xlsx') {
    body = sheetsToXlsx(sheets);
  } else if (spec.id === 'csv' || spec.id === 'tsv' || spec.id === 'md') {
    // these have no sheet concept: stack the tables with their names above
    const writer = spec.id === 'csv' ? toCsv : spec.id === 'tsv' ? toTsv : toMarkdown;
    body = sheets
      .map((sheet) => (sheets.length > 1 ? `# ${sheet.name}\n` : '') + writer(sheet.rows))
      .join('\r\n');
  } else if (spec.id === 'html') {
    body = toHtml(sheets, { title: options.title || 'MMPI-2 导出' });
  } else {
    body = toJson(sheets);
  }
  return {
    filename: `${basename}.${spec.ext}`,
    mime: MIME[spec.id],
    body,
    binary: spec.id === 'xlsx',
  };
}

/* -- reading answers back in ------------------------------------------- */

export const ANSWER_TRUE = new Set(['t', 'true', '1', 'y', 'yes', '是', '对', '真']);
export const ANSWER_FALSE = new Set(['f', 'false', '0', 'n', 'no', '否', '错', '假']);
const ANSWER_UNKNOWN = new Set(['?', '', '?', '未知']);

/**
 * Parse answers pasted from anywhere: a 567-char T/F string, one answer per
 * line, or a csv/tsv whose last column holds the answer.
 *
 * @returns {{answers: Array<boolean|null>, found: number, unknown: number[], errors: string[]}}
 */
export function parseAnswers(text, options = {}) {
  const { data = MMPI2_DATA } = options;
  const errors = [];
  const cells = [];
  const source = String(text ?? '');

  const stripped = source.replace(/\s+/g, '');
  // 纯数字/问号串：TF 的 0/1 串，或 Likert/Choice 的级别串（每字一个级别）
  const digitCompact = stripped.match(/[0-9?]/g);
  if (
    digitCompact &&
    digitCompact.length === data.nItems &&
    !/[,;\t]/.test(source) &&
    !/[A-Za-z]/.test(source)
  ) {
    for (const ch of digitCompact) {
      if (ch === '?') cells.push(null);
      else {
        const v = Number(ch);
        // 0/1 仍按 TF 布尔处理，保持与旧版兼容；更高级别保留为整型
        cells.push(v === 0 ? false : v === 1 ? true : v);
      }
    }
    return finish(cells, data, errors);
  }
  const compact = stripped.match(/[TFtf01?]/g);
  if (compact && compact.length === data.nItems && !/[,;\t]/.test(source)) {
    // a bare 567-character string
    for (const ch of compact) {
      const lower = ch.toLowerCase();
      if (ANSWER_UNKNOWN.has(lower)) cells.push(null);
      else if (ANSWER_TRUE.has(lower)) cells.push(true);
      else cells.push(false);
    }
    return finish(cells, data, errors);
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // "42 T", "42,T", "42. True", "42 3"（多级题的级别），或单独的 "T" / "3"
    let token = line;
    const numbered = line.match(/^\s*(\d{1,3})\s*[.,:、\s\t]+\s*(.+)$/);
    if (numbered) token = numbered[2].trim();
    const parts = token.split(/[,\t;]/).map((p) => p.trim()).filter(Boolean);
    token = parts.length ? parts[parts.length - 1] : token;
    const lower = token.toLowerCase();
    if (ANSWER_UNKNOWN.has(lower)) cells.push(null);
    else if (ANSWER_TRUE.has(lower)) cells.push(true);
    else if (ANSWER_FALSE.has(lower)) cells.push(false);
    else if (/^\d+$/.test(token)) cells.push(Number(token));
    else errors.push(`无法识别：${rawLine.slice(0, 40)}`);
  }
  return finish(cells, data, errors);
}

function finish(cells, data, errors) {
  const answers = [];
  const unknown = [];
  for (let i = 0; i < data.nItems; i += 1) {
    const value = cells[i];
    answers.push(value === undefined ? null : value);
    if (value === null || value === undefined) unknown.push(i + 1);
  }
  return {
    answers,
    found: data.nItems - unknown.length,
    unknown,
    errors,
    extra: cells.length > data.nItems ? cells.length - data.nItems : 0,
  };
}

/** Blanks make every scale unscorable, so fill them with a deterministic guess.
 *  TF 题仍随机布尔；多级量表按该格式的级别数随机取一个级别。 */
export function fillUnknown(answers, options = {}) {
  const { seed = 1, data = MMPI2_DATA } = options;
  let state = seed >>> 0 || 1;
  const rng = () => {
    state = (state * 1103515245 + 12345) % 2147483647;
    return state / 2147483647;
  };
  const out = answers.slice();
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === null || out[i] === undefined) {
      const L = levelCount(itemFormatDesc(data, i + 1));
      out[i] = L <= 2 ? (rng() < 0.5) : Math.floor(rng() * L);
    }
  }
  return out;
}
