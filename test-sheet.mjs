/**
 * Node test for the export layer: web/sheet.js and web/xlsx.js.
 *
 *   node web/test-sheet.mjs
 *
 * The xlsx half matters most: nothing here depends on a library, so a broken
 * ZIP or a missing part produces a file that Excel refuses to open and nothing
 * else in the repo would notice.  The container is therefore re-parsed from
 * scratch -- central directory, CRCs, offsets, entry names -- instead of
 * trusting the writer's own bookkeeping.
 */

import { MMPI2_DATA as DATA } from './data.js';
import { planSheet } from './gui.js';
import { scoreAnswers } from './inverse.js';
import {
  answerSheet,
  profileSheet,
  targetSheet,
  blankTemplate,
  buildSheets,
  serialize,
  toCsv,
  toTsv,
  toMarkdown,
  toHtml,
  toJson,
  parseAnswers,
  fillUnknown,
  cnT,
  itemText,
} from './sheet.js';
import { zip, sheetsToXlsx, colName, safeSheetName } from './xlsx.js';

let failures = 0;
const check = (ok, label, extra = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

/* -- ZIP container ------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Re-read the archive the way a real unzipper would. */
function unzip(bytes) {
  const eocd = (() => {
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
    }
    throw new Error('no end-of-central-directory record');
  })();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`bad central signature at ${at}`);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    // read the data straight out of the local entry
    const lNameLen = view.getUint16(localAt + 26, true);
    const lExtraLen = view.getUint16(localAt + 28, true);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(start, start + size);
    out.push({ name, method, crc, size, data });
    at += 46 + nameLen;
  }
  return out;
}

{
  const bytes = zip([{ name: 'a.txt', data: new TextEncoder().encode('hello 世界') }]);
  const entries = unzip(bytes);
  check(entries.length === 1, 'ZIP 中央目录可读且条目数正确', `${entries.length}`);
  check(entries[0].name === 'a.txt', '条目名保留（UTF-8）', entries[0].name);
  check(entries[0].crc === crc32(entries[0].data), 'CRC32 与内容一致');
  check(entries[0].method === 0, '方法是 stored（无需 deflate）');
  check(
    new TextDecoder().decode(entries[0].data) === 'hello 世界',
    '非 ASCII 内容往返无损'
  );
}

/* -- xlsx --------------------------------------------------------------- */

const plan = planSheet({ targets: { Hs: 70, Sc: 81, Pt: 74 }, isMale: true, seed: 3 });

{
  const sheets = buildSheets(plan, { content: ['answers', 'profile', 'targets'] });
  check(sheets.length === 3, 'buildSheets 返回三张表', sheets.map((s) => s.name).join(' / '));

  const bytes = sheetsToXlsx(sheets);
  check(bytes.length > 2000, 'xlsx 有实际体积', `${bytes.length} bytes`);
  check(
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04,
    '以 PK\\x03\\x04 开头（是个真 ZIP）'
  );

  const entries = unzip(bytes);
  const names = entries.map((e) => e.name);
  for (const required of [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/sharedStrings.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
    'xl/worksheets/sheet3.xml',
  ]) {
    check(names.includes(required), `包含 ${required}`);
  }
  check(
    entries.every((e) => e.crc === crc32(e.data)),
    '所有条目的 CRC32 都对'
  );

  const sheetXml = new TextDecoder().decode(entries.find((e) => e.name === 'xl/worksheets/sheet1.xml').data);
  check(/<row r="1"/.test(sheetXml), 'sheet1 有表头行');
  check(/<row r="568"/.test(sheetXml), '答题表 568 行（表头 + 567 题）');
  check(!/[\x00-\x08]/.test(sheetXml), '没有裸控制字符（Excel 会拒收）');

  const workbookXml = new TextDecoder().decode(entries.find((e) => e.name === 'xl/workbook.xml').data);
  check((workbookXml.match(/<sheet /g) || []).length === 3, 'workbook.xml 声明三张表');

  const sst = new TextDecoder().decode(entries.find((e) => e.name === 'xl/sharedStrings.xml').data);
  const declared = Number((sst.match(/uniqueCount="(\d+)"/) || [])[1]);
  const actual = (sst.match(/<si>/g) || []).length;
  check(declared === actual && actual > 100, 'sharedStrings 计数与实际一致', `${actual}`);
  // strings live in the shared table, so the Chinese has to be correct *there*
  check(sst.includes('题号') && sst.includes('影响的量表'), '中文列名进了 sharedStrings');
  check(sst.includes(itemText(7).zh), '题干文本进了 sharedStrings');
}

{
  // shared strings must be shared: 567 rows repeating "T"/"F" is 2 entries, not 567
  const bytes = sheetsToXlsx([answerSheet(plan)]);
  const sst = new TextDecoder().decode(unzip(bytes).find((e) => e.name === 'xl/sharedStrings.xml').data);
  const count = (sst.match(/<si>/g) || []).length;
  check(count < 1200, '字符串被去重（不是每题一份）', `${count} 个唯一串`);
}

{
  const bad = safeSheetName('a/b?c*d[e]:f');
  check(!/[\\/?*[\]:]/.test(bad), '工作表非法字符被替换', bad);
  check(safeSheetName('x'.repeat(50)).length === 31, '工作表名截断到 31 字符');
  check(colName(1) === 'A' && colName(26) === 'Z' && colName(27) === 'AA', '列名换算正确');
}

/* -- the tables themselves --------------------------------------------- */

{
  const sheet = answerSheet(plan, { withEnglish: true, withLockInfo: true });
  check(sheet.rows.length === 568, '答题表 568 行');
  check(sheet.rows[0].length === 6, '答题表 6 列', sheet.rows[0].join('|'));
  const row = sheet.rows[42];
  check(row[0] === 42, '题号列连续', String(row[0]));
  check(row[1] === itemText(42).zh, '中文题干与题库一致');
  check(row[3] === itemText(42).en, '英文题干与题库一致');
  check(row[4] === '自由' || row[4] === '锁定', '状态列有值', row[4]);
  const locked = sheet.rows.slice(1).filter((r) => r[4] === '锁定');
  check(
    locked.every((r) => typeof r[5] === 'string' && r[5].length > 0),
    '锁定题都写了影响的量表',
    `${locked.length} 道`
  );
}

{
  const sheet = profileSheet(plan, { isMale: true });
  check(sheet.rows.length === 88, '剖面表 88 行（表头 + 87 量表）', String(sheet.rows.length));
  const hs = sheet.rows.slice(1).find((r) => r[0] === 'Hs');
  check(hs[5] === plan.profile.Hs, '剖面里的美国 T 与求解结果一致', `${hs[5]}`);
  check(hs[6] === cnT('Hs', plan.profile.Hs, true), '剖面里的中国 T 与换算函数一致', `${hs[6]}`);
  check(typeof hs[3] === 'number', '剖面带原始分', String(hs[3]));
  check(hs[4] === '+0.5K', 'Hs 标出 K 校正', String(hs[4]));
  const sc1 = sheet.rows.slice(1).find((r) => r[0] === 'Sc1');
  check(sc1[7] === '无中国常模', '无中国常模的量表写清楚，不编数', String(sc1[7]));
}

{
  const sheet = targetSheet(plan, { isMale: true });
  check(sheet.rows.length === 1 + Object.keys(plan.target).length, '目标表行数正确');
  check(sheet.rows[1][4] === 0, '完全命中时偏差为 0', JSON.stringify(sheet.rows[1]));
}

{
  const sheet = blankTemplate();
  check(sheet.rows.length === 568, '空白模板 568 行');
  check(sheet.rows.slice(1).every((r) => r[2] === ''), '空白模板的作答列留空');
}

/* -- other formats ------------------------------------------------------ */

{
  const sheets = buildSheets(plan, { content: ['answers'], withEnglish: false });
  const csv = serialize(sheets, 'csv');
  check(csv.filename.endsWith('.csv'), 'csv 文件名', csv.filename);
  check(csv.body.startsWith('﻿'), 'csv 带 BOM（Excel 中文不乱码）');
  check(csv.body.split('\r\n').length >= 568, 'csv 行数', String(csv.body.split('\r\n').length));

  const rows = [[1, '中文, 带逗号', 'T'], [2, '带"引号"', 'F']];
  const escaped = toCsv(rows, { bom: false });
  check(escaped.includes('"中文, 带逗号"'), 'csv 给含逗号的字段加引号');
  check(escaped.includes('"带""引号"""'), 'csv 双写引号');

  check(toTsv(rows).includes('\t'), 'tsv 用制表符分隔');
  check(toMarkdown(rows).startsWith('| 1 |'), 'markdown 是管道表');
  check(toHtml(sheets).includes('<table>'), 'html 有表格');
  const json = JSON.parse(toJson(sheets));
  check(Object.keys(json).length === 1, 'json 按表名分组');
  check(json['答题表'].length === 567, 'json 记录数 567', String(json['答题表'].length));
}

{
  const sheets = buildSheets(null, { content: ['template'] });
  check(sheets.length === 1, '未求解时仍能导出空白模板');
  const out = serialize(sheets, 'xlsx');
  check(out.binary === true, 'xlsx 标记为二进制');
  check(out.mime.includes('spreadsheetml'), 'xlsx MIME 正确', out.mime);
}

/* -- reading answers back in ------------------------------------------- */

{
  const compact = plan.answers.map((a) => (a ? 'T' : 'F')).join('');
  const parsed = parseAnswers(compact);
  check(parsed.found === 567, '读入 567 字符的 T/F 串', String(parsed.found));
  check(
    parsed.answers.every((a, i) => a === plan.answers[i]),
    '读入结果与原文逐题一致'
  );
  const scored = scoreAnswers(parsed.answers, { isMale: true, correctInconsistency: false });
  check(scored.byName.Hs === plan.profile.Hs, '回读后 Hs 分数不变', `${scored.byName.Hs}`);
  check(scored.byName.Sc === plan.profile.Sc, '回读后 Sc 分数不变', `${scored.byName.Sc}`);

  const lines = plan.answers.map((a, i) => `${i + 1} ${a ? 'True' : 'False'}`).join('\n');
  check(parseAnswers(lines).found === 567, '读入「题号 答案」逐行格式');

  const csvText = `题号,回答\n${plan.answers.map((a, i) => `${i + 1},${a ? 'T' : 'F'}`).join('\n')}\n`;
  const fromCsv = parseAnswers(csvText);
  check(fromCsv.found === 567, '读入 csv 导出件（表头不干扰）', String(fromCsv.found));

  const gapped = (compact.slice(0, 4) + '?' + compact.slice(5)).split('');
  gapped[200] = '?';
  const p = parseAnswers(gapped.join(''));
  check(
    p.unknown.length === 2 && p.unknown[0] === 5 && p.unknown[1] === 201,
    '? 记为未作答',
    JSON.stringify(p.unknown)
  );
  check(p.found === 565, '已作答题数正确', String(p.found));
  check(fillUnknown(p.answers).every((a) => typeof a === 'boolean'), '未作答可填充');
  check(parseAnswers('随便乱写').found === 0, '完全读不出时返回 0');
}

console.log(failures ? `\n${failures} 项失败` : '\nALL OK');
process.exit(failures ? 1 : 0);
