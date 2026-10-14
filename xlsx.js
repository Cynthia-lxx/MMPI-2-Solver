/**
 * A minimal, dependency-free .xlsx writer.
 *
 * The GUI has to be a single folder of static files (and one inlined HTML), so
 * pulling in a spreadsheet library is not an option -- but "export to Excel"
 * is the whole point of a question/answer sheet.  An .xlsx is just a ZIP of
 * XML parts, and a ZIP may store its entries uncompressed, so this writes
 * ~200 lines of OOXML plus a stored-only ZIP container and produces a file
 * Excel, LibreOffice, WPS and Numbers all open.
 *
 * Scope, deliberately: one header row (bold, frozen), string and number cells,
 * shared strings, column widths, autofilter.  No merged cells, no formulas,
 * no dates -- the data here does not need them.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Frozen at 2026-01-01: the bytes have to say *something*. */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

function utf8(text) {
  return new TextEncoder().encode(text);
}

/** 1 -> A, 27 -> AA. */
export function colName(n) {
  let out = '';
  let rest = n;
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    rest = (rest - 1 - rem) / 26;
  }
  return out;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // spreadsheets reject most control characters outright
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// -- ZIP ----------------------------------------------------------------

/**
 * A ZIP using stored (uncompressed) entries.
 * `entries` is [{name, data: Uint8Array}].
 */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // general purpose: UTF-8 names
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // relative offset of local header
    central.set(nameBytes, 46);

    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + size;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment length

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// -- OOXML --------------------------------------------------------------

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Excel rejects sheet names containing these, and caps them at 31 chars. */
export function safeSheetName(name, fallback = 'Sheet') {
  const cleaned = String(name).replace(/[\\/?*[\]:]/g, '·').trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 31);
}

function uniqueSheetNames(names) {
  const seen = new Set();
  return names.map((raw, i) => {
    let base = safeSheetName(raw, `Sheet${i + 1}`);
    let candidate = base;
    let n = 2;
    while (seen.has(candidate)) {
      const suffix = ` ${n}`;
      candidate = base.slice(0, 31 - suffix.length) + suffix;
      n += 1;
    }
    seen.add(candidate);
    return candidate;
  });
}

/**
 * @param {Array<{name: string, rows: Array<Array<string|number|null>>, widths?: number[]}>} sheets
 * @returns {Uint8Array} the .xlsx bytes
 */
export function sheetsToXlsx(sheets) {
  const names = uniqueSheetNames(sheets.map((s) => s.name));

  // shared strings: every distinct string cell, in first-use order
  const shared = [];
  const sharedIndex = new Map();
  const intern = (text) => {
    const key = String(text);
    if (!sharedIndex.has(key)) {
      sharedIndex.set(key, shared.length);
      shared.push(key);
    }
    return sharedIndex.get(key);
  };

  const sheetXml = sheets.map((sheet, si) => {
    const rows = sheet.rows || [];
    const cols = (sheet.widths || []).length
      ? `<cols>${sheet.widths
          .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
          .join('')}</cols>`
      : '';

    const body = rows
      .map((row, ri) => {
        const cells = row
          .map((cell, ci) => {
            if (cell === null || cell === undefined || cell === '') return '';
            const ref = `${colName(ci + 1)}${ri + 1}`;
            if (typeof cell === 'number' && Number.isFinite(cell)) {
              return `<c r="${ref}"><v>${cell}</v></c>`;
            }
            const value = typeof cell === 'boolean' ? (cell ? 'TRUE' : 'FALSE') : cell;
            return `<c r="${ref}" t="s"><v>${intern(value)}</v></c>`;
          })
          .join('');
        // style 1 = bold; applied to the row, so empty cells inherit it too
        const rowStyle = ri === 0 ? ' s="1" customFormat="1"' : '';
        return `<row r="${ri + 1}"${rowStyle}>${cells}</row>`;
      })
      .join('');

    const headerCells = (rows[0] || []).length;
    const lastCol = colName(Math.max(1, headerCells));
    const filter = rows.length > 1 ? `<autoFilter ref="A1:${lastCol}${rows.length}"/>` : '';

    return {
      name: `xl/worksheets/sheet${si + 1}.xml`,
      data: utf8(
        XML_DECL +
          `<worksheet xmlns="${NS_MAIN}">` +
          `<sheetPr/>` +
          `<dimension ref="A1:${lastCol}${Math.max(1, rows.length)}"/>` +
          `<sheetViews><sheetView workbookViewId="0">` +
          `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
          `</sheetView></sheetViews>` +
          `<sheetFormatPr defaultRowHeight="15"/>` +
          cols +
          `<sheetData>${body}</sheetData>` +
          filter +
          `</worksheet>`
      ),
    };
  });

  const withHeaderStyle = sheetXml;
  const contentTypes =
    XML_DECL +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    withHeaderStyle
      .map(
        (part, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join('') +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`;

  const rootRels =
    XML_DECL +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbook =
    XML_DECL +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets>${names
      .map(
        (name, i) =>
          `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
      )
      .join('')}</sheets>` +
    `</workbook>`;

  // sheets take rId1..rIdN; styles and shared strings follow
  const stylesId = `rId${names.length + 1}`;
  const stringsId = `rId${names.length + 2}`;
  const workbookRels =
    XML_DECL +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    withHeaderStyle
      .map(
        (part, i) =>
          `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
      )
      .join('') +
    `<Relationship Id="${stylesId}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="${stringsId}" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`;

  const styles =
    XML_DECL +
    `<styleSheet xmlns="${NS_MAIN}">` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const sharedStrings =
    XML_DECL +
    `<sst xmlns="${NS_MAIN}" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('') +
    `</sst>`;

  return zip([
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
    { name: 'xl/styles.xml', data: utf8(styles) },
    { name: 'xl/sharedStrings.xml', data: utf8(sharedStrings) },
    ...withHeaderStyle,
  ]);
}
