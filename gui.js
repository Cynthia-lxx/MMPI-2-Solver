/**
 * MMPI-2 inverse-solver GUI.
 *
 * Left: pick a target T score for any of the 87 scales (dropdowns carry only
 * values the T tables can actually produce).  Right: a 567-item answer sheet
 * that hits them, with every item marked either locked (flipping it would move
 * a targeted scale) or free -- the free items are the "possible answer
 * combinations", 2 ** n of them.
 *
 * The DOM-free core (planSheet, randomizeFree, answersToCsv, parseBulkTargets)
 * is exported so web/test-gui.mjs can exercise it under Node.
 */

import { MMPI2_DATA } from './data.js';
import {
  InverseModel,
  solve,
  scoreAnswers,
  scaleOptions,
  nearestReachable,
  makeRng,
  normalizeTarget,
  distanceOutside,
  targetPoint,
} from './inverse.js';
import {
  itemText,
  cnT,
  usTForCn60,
  buildSheets,
  serialize,
  parseAnswers,
  fillUnknown,
  EXPORT_CONTENTS,
  EXPORT_FORMATS,
} from './sheet.js';
import { itemFormatDesc } from './formats.js';
import {
  SCL90_DATA,
  scl90Score,
  scl90Solve,
  scl90ItemText,
  scl90TargetScales,
  scl90ParseAnswers,
  scl90ExportCsv,
  scl90FeasibleBounds,
  scl90SetItemLevel,
  levelToScore,
} from './scl90.js';

export { MMPI2_DATA };
export { itemText, cnT, usTForCn60, buildSheets, serialize, parseAnswers, EXPORT_CONTENTS, EXPORT_FORMATS };

export const FAMILY_LABELS = {
  basic: '基本量表（效度 + 临床）',
  harris_lingoes: 'Harris–Lingoes 亚量表',
  wiener_harmon: 'Wiener–Harmon 亚量表',
  si: 'Si 亚量表',
  supplemental: '补充量表（含 VRIN / TRIN）',
};

/** 量表中文名（标准 MMPI-2 中文版译名）。找不到时回退到纯英文。 */
export const SCALE_CN = {
  // 基本量表
  L: '说谎', F: '诈病', K: '校正（防御）',
  Hs: '疑病', D: '抑郁', Hy: '癔症', Pd: '精神病态偏倚', Mf: '男子气-女子气',
  Pa: '偏执', Pt: '精神衰弱', Sc: '精神分裂', Ma: '轻躁狂', Si: '社会内向',
  // Harris–Lingoes 亚量表
  D1: '主观抑郁', D2: '精神运动迟缓', D3: '躯体机能障碍', D4: '精神迟钝', D5: '优柔寡断',
  Hy1: '否认社会焦虑', Hy2: '情感需要', Hy3: '懒散不适', Hy4: '躯体主诉', Hy5: '抑制攻击',
  Pd1: '家庭不和', Pd2: '权威冲突', Pd3: '社会超然', Pd4: '社会疏离', Pd5: '自我疏离',
  Pa1: '被迫害观念', Pa2: '愤懑尖锐', Pa3: '天真',
  Sc1: '社会疏离', Sc2: '情感疏离', Sc3: '自我掌控缺失（认知）',
  Sc4: '自我掌控缺失（意动）', Sc5: '自我掌控缺失（抑制缺陷）', Sc6: '奇异感官体验',
  Ma1: '非道德', Ma2: '精神运动加速', Ma3: '超然', Ma4: '自我膨胀',
  // Wiener–Harmon 亚量表（显性 / 隐性）
  'D-O': '依赖（显性）', 'D-S': '依赖（隐性）',
  'Hy-O': '癔症（显性）', 'Hy-S': '癔症（隐性）',
  'Pd-O': '病态人格（显性）', 'Pd-S': '病态人格（隐性）',
  'Pa-O': '偏执（显性）', 'Pa-S': '偏执（隐性）',
  'Ma-O': '轻躁狂（显性）', 'Ma-S': '轻躁狂（隐性）',
  // Si 亚量表
  Si1: '羞怯', Si2: '社交回避', Si3: '自我疏离',
  // 补充量表
  A: '焦虑', R: '压抑', Es: '自我强度', 'MAC-R': '麦克安德鲁酗酒（修订）', FB: 'F后',
  VRIN: '变量应答不一致', TRIN: '同向应答不一致', 'O-H': '过度控制敌意', Do: '支配性',
  Re: '社会责任', Mt: '大学适应不良', GM: '性别角色-男性化', GF: '性别角色-女性化',
  PK: '创伤后应激（基恩）', PS: '创伤后应激（施伦格）', MDS: '婚姻困扰',
  APS: '成瘾倾向', AAS: '成瘾承认',
  ANX: '焦虑', FRS: '恐惧', OBS: '强迫', DEP: '抑郁', HEA: '健康关注', BIZ: '古怪思维',
  ANG: '愤怒', CYN: '愤世嫉俗', ASP: '反社会行为', TPA: 'A型行为', LSE: '低自尊',
  SOD: '社交不适', FAM: '家庭问题', WRK: '工作困扰', TRT: '负性治疗指标',
};

/** 量表中文名，没有对应项时返回空串。 */
export function cnName(name) {
  return SCALE_CN[name] || '';
}

export const FAMILY_ORDER = ['basic', 'harris_lingoes', 'wiener_harmon', 'si', 'supplemental'];

export const ITERATION_PRESETS = { quick: 60000, standard: 200000, deep: 600000 };

/**
 * The four ways a target can be stated.  All of them are the same thing
 * underneath -- an interval -- so the solver only ever sees {lo, hi}:
 *
 *   exact    Hs = 70            {lo: 70, hi: 70}
 *   range    Hs in 65..75       {lo: 65, hi: 75}
 *   atLeast  Hs >= 65           {lo: 65, hi: tableMax}
 *   atMost   Hs <= 70           {lo: tableMin, hi: 70}
 */
export const TARGET_MODES = [
  { id: 'exact', label: '精确值（=）', edges: ['point'] },
  { id: 'range', label: '区间（lo…hi）', edges: ['lo', 'hi'] },
  { id: 'atLeast', label: '不低于（≥）', edges: ['lo'] },
  { id: 'atMost', label: '不高于（≤）', edges: ['hi'] },
];

/**
 * A mildly elevated clinical profile per gender, for the "载入示例" button.
 * Both sets were produced by running the solver, so they are jointly reachable
 * -- a hand-picked "nice looking" profile usually is not (Hs 70 + D 65 +
 * Hy 72 + ... has no solution for males: 13 scales over 567 shared items
 * constrain each other, and Hs tops out at 68).
 */
export const EXAMPLE_TARGETS = {
  male: { L: 52, F: 55, K: 54, Hs: 68, D: 64, Hy: 71, Pd: 67, Mf: 54, Pa: 64, Pt: 74, Sc: 77, Ma: 59, Si: 55 },
  female: { L: 52, F: 55, K: 54, Hs: 69, D: 64, Hy: 73, Pd: 68, Mf: 55, Pa: 67, Pt: 73, Sc: 76, Ma: 59, Si: 55 },
};

/* ------------------------------------------------------------------ *
 * core (no DOM)
 * ------------------------------------------------------------------ */

/**
 * Solve for `targets` and classify every item as free or locked.
 *
 * Returns {answers, achieved, target, requested, residual, loss, feasible,
 * freedom[1..567], freeItems, lockedItems, lockReason, profile}.
 */
/** Nearest value a scale can really take, for this gender and VRIN/TRIN formula. */
function snapTo(list, value) {
  return list.includes(value) ? value : nearestReachable(list, value);
}

/**
 * Which items can be flipped without breaking anything.
 *
 * `freedom` is the structural answer -- the item keys into none of the targeted
 * scales, so *any subset* of those items can be flipped at once (that is what
 * makes "2 ** n combinations" true).
 *
 * `slack` is the weaker, range-only answer: the item does key into a targeted
 * scale, but flipping it once still leaves every target inside its interval.
 * Those are safe one at a time, never in bulk: two of them can push the same
 * scale the same way and walk it out of the range.  The GUI therefore only
 * ever flips them with a re-check in between.
 */
export function analyseFreedom(answers, targets, options = {}) {
  const { isMale = true, correctInconsistency = false, data = MMPI2_DATA } = options;
  const model = new InverseModel(data, { isMale, correctInconsistency });
  model.reset(answers);

  const names = Object.keys(targets || {});
  const bounds = new Map();
  const flats = [];
  for (const name of names) {
    const flat = model.nameToFlat.get(name);
    flats.push(flat);
    bounds.set(flat, normalizeTarget(targets[name]));
  }
  const hasRange = [...bounds.values()].some((spec) => spec.lo !== spec.hi);

  const locks = model.itemLocks(flats);
  const freeItems = [];
  const lockedItems = [];
  const lockReason = new Map();
  for (let item = 1; item <= data.nItems; item += 1) {
    if (locks[item].length) {
      lockedItems.push(item);
      lockReason.set(item, locks[item].map(formatLock));
    } else {
      freeItems.push(item);
    }
  }
  const freedom = new Array(data.nItems + 1).fill(false);
  for (const item of freeItems) freedom[item] = true;

  const slackItems = [];
  const slack = new Array(data.nItems + 1).fill(false);
  if (hasRange) {
    for (const item of lockedItems) {
      const touched = model._touched(item);
      const before = new Map();
      for (const flat of touched) before.set(flat, model.ts[flat]);
      model._mutate(item);
      for (const flat of touched) model.ts[flat] = model._computeT(flat);
      let ok = true;
      for (const [flat, spec] of bounds) {
        if (distanceOutside(model.ts[flat], spec) !== 0) {
          ok = false;
          break;
        }
      }
      model._mutate(item);
      for (const [flat, value] of before) model.ts[flat] = value;
      if (ok) {
        slackItems.push(item);
        slack[item] = true;
      }
    }
  }

  return { freedom, freeItems, lockedItems, lockReason, slackItems, slack };
}

export function planSheet(options = {}) {
  const {
    targets,
    isMale = true,
    correctInconsistency = false,
    iterations = ITERATION_PRESETS.standard,
    seed = 1,
    snapToReachable = true,
    start = null,
    data = MMPI2_DATA,
  } = options;

  const names = Object.keys(targets || {});
  if (!names.length) throw new Error('至少指定一个量表的目标 T 分');

  // snap against the value list for this gender *and* VRIN/TRIN formula --
  // solve() only knows the raw table, which over-promises for VRIN and TRIN.
  // A range is snapped bound by bound: asking for 66..74 can come back as
  // 65..74 when 66 is not a value the table can produce.
  const wanted = {};
  const lists = {};
  for (const [name, spec] of Object.entries(targets)) {
    const list = reachableValuesFor(name, isMale, correctInconsistency, data);
    lists[name] = list;
    const interval = normalizeTarget(spec);
    wanted[name] = { lo: snapTo(list, interval.lo), hi: snapTo(list, interval.hi) };
  }
  const hasRange = names.some((name) => wanted[name].lo !== wanted[name].hi);

  // startSheet only reads VRIN / TRIN, and it wants plain numbers
  const startWanted = {};
  for (const [name, spec] of Object.entries(wanted)) {
    startWanted[name] = targetPoint(spec, lists[name]);
  }

  const result = solve(wanted, {
    isMale,
    correctInconsistency,
    iterations,
    seed,
    snapToReachable,
    start: start || startSheet(startWanted, { correctInconsistency, isMale, data }),
    data,
  });

  const analysis = analyseFreedom(result.answers, wanted, {
    isMale,
    correctInconsistency,
    data,
  });
  const scored = scoreAnswers(result.answers, { isMale, correctInconsistency, data });

  return {
    answers: result.answers,
    achieved: result.achieved,
    target: result.target,
    bounds: result.bounds,
    requested: { ...targets }, // what the user asked for, before snapping
    residual: result.residual,
    loss: result.loss,
    feasible: result.feasible,
    audit: result.audit,
    hasRange,
    freedom: analysis.freedom,
    freeItems: analysis.freeItems,
    slack: analysis.slack,
    slackItems: analysis.slackItems,
    lockedItems: analysis.lockedItems,
    lockReason: analysis.lockReason,
    profile: scored.byName,
    rawByName: scored.rawByName,
    isMale,
    correctInconsistency,
  };
}

function formatLock(reason) {
  return reason.viaK ? `${reason.name}（经 K 校正）` : reason.name;
}

/**
 * Start sheet that already sits on the targeted VRIN / TRIN raw score.
 *
 * Why this exists: from the all-False sheet both inconsistency raw scores land
 * outside their tables (legacy TRIN raw = 9 + 0 + 23 = 32 and corrected TRIN
 * raw = 9 + 0 - 23 = -14, corrected VRIN raw = 67 - 35 = 32 -- the tables have
 * 20 and 25 entries).  A clamped scale returns the same T for every single
 * flip, so the search has no gradient at all and just random-walks.  Building
 * the start from the target itself puts the scale inside the table, where one
 * flip moves it one step.
 *
 * VRIN and TRIN share items, so when both are targeted the TRIN assignment
 * wins on the shared ones; the solver then has gradient to repair the rest.
 */
export function startSheet(targets, options = {}) {
  // VRIN and TRIN share 27 items, so the writing order decides who keeps them.
  // Build both orders and keep the one that lands closer to the two targets.
  const vrinFirst = buildStart(targets, options, 'vrin');
  if (targets.VRIN === undefined || targets.TRIN === undefined) return vrinFirst;
  const trinFirst = buildStart(targets, options, 'trin');

  const { correctInconsistency = false, isMale = true, data = MMPI2_DATA } = options;
  const model = new InverseModel(data, { isMale, correctInconsistency });
  const cost = (sheet) => {
    model.reset(sheet);
    return (
      Math.abs(model.ts[data.vrinFlat] - targets.VRIN) +
      Math.abs(model.ts[data.trinFlat] - targets.TRIN)
    );
  };
  return cost(vrinFirst) <= cost(trinFirst) ? vrinFirst : trinFirst;
}

function buildStart(targets, options, priority) {
  const { correctInconsistency = false, isMale = true, data = MMPI2_DATA } = options;
  const answers = new Array(data.nItems).fill(false);
  const resp = data.response;
  const tables = (isMale ? data.male : data.female).tables;
  const combos = [[false, false], [false, true], [true, false], [true, true]];
  const claimed = new Set();
  const groupOf = (map, a, b) => {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (!map.has(key)) map.set(key, { a, b, copies: [], nTrue: 0, nFalse: 0 });
    return map.get(key);
  };

  const writeTrin = () => {
    if (targets.TRIN === undefined) return;
    const raw = tables[4][6].indexOf(targets.TRIN);
    if (raw === -1) return;
    const diff = raw - 9; // both formulas are centred on raw 9
    const map = new Map();
    for (let j = 0; j < resp.truePairs.length; j += 2) {
      groupOf(map, resp.truePairs[j], resp.truePairs[j + 1]).nTrue += 1;
    }
    for (let j = 0; j < resp.falsePairs.length; j += 2) {
      groupOf(map, resp.falsePairs[j], resp.falsePairs[j + 1]).nFalse += 1;
    }
    const all = [...map.values()];
    const blocked = (group) => claimed.has(group.a) || claimed.has(group.b);
    // mixed answers: contributes to neither bothTrue nor bothFalse
    for (const group of all) {
      if (!blocked(group)) {
        answers[group.a - 1] = true;
        answers[group.b - 1] = false;
      }
    }
    // corrected: bothTrue - bothFalse = diff;  original: bothTrue + bothFalse = diff
    let budget = correctInconsistency ? Math.abs(diff) : Math.max(0, diff);
    const used = new Set();
    const spend = (field, value) => {
      for (const group of all) {
        if (budget > 0 && group[field] && !used.has(group) && !blocked(group)) {
          answers[group.a - 1] = value;
          answers[group.b - 1] = value;
          budget -= group[field];
          used.add(group);
        }
      }
    };
    if (!correctInconsistency || diff > 0) spend('nTrue', true);
    spend('nFalse', false);
    for (const item of resp.truePairs) claimed.add(item);
    for (const item of resp.falsePairs) claimed.add(item);
  };

  const writeVrin = () => {
    if (targets.VRIN === undefined) return;
    const map = new Map();
    for (let j = 0; j < resp.vrinPairs.length; j += 2) {
      groupOf(map, resp.vrinPairs[j], resp.vrinPairs[j + 1]).copies.push([
        resp.vrinExpected[j],
        resp.vrinExpected[j + 1],
      ]);
    }
    const creditOf = (group, combo) =>
      group.copies.filter(([ea, eb]) => combo[0] === ea && combo[1] === eb).length;

    // groups sharing an item with a scale written first keep its answers
    const free = [];
    let remaining = wantedConsistency(targets.VRIN, isMale, correctInconsistency, data);
    for (const group of map.values()) {
      if (claimed.has(group.a) || claimed.has(group.b)) {
        remaining -= creditOf(group, [answers[group.a - 1], answers[group.b - 1]]);
      } else {
        free.push(group);
      }
    }
    for (const group of free) {
      const credits = combos.map((combo) => creditOf(group, combo));
      const fit = credits.filter((credit) => credit <= Math.max(0, remaining)).sort((a, b) => b - a);
      const want = Math.max(0, fit.length ? fit[0] : 0);
      const combo = combos[credits.indexOf(want)];
      remaining -= want;
      answers[group.a - 1] = combo[0];
      answers[group.b - 1] = combo[1];
    }
    for (const item of resp.vrinPairs) claimed.add(item);
  };

  if (priority === 'vrin') {
    writeVrin();
    writeTrin();
  } else {
    writeTrin();
    writeVrin();
  }
  return answers;
}

/** Reshuffle the free items -- they cannot change the targeted T scores. */
export function randomizeFree(answers, freeItems, seed = 0) {
  const rng = makeRng(seed);
  const out = answers.slice();
  for (const item of freeItems) out[item - 1] = rng() < 0.5;
  return out;
}

/**
 * Same, plus the slack items of a range target -- flipped one at a time, and a
 * flip is only kept when every target is still satisfied.
 *
 * They have to go one at a time: two slack items can move the same scale in the
 * same direction, and together they would walk it out of its interval even
 * though each one alone is harmless.
 */
export function randomizeWithinBounds(answers, targets, options = {}) {
  const {
    freeItems = [],
    slackItems = [],
    seed = 0,
    isMale = true,
    correctInconsistency = false,
    data = MMPI2_DATA,
  } = options;

  const out = randomizeFree(answers, freeItems, seed);
  if (!slackItems.length) return out;

  const rng = makeRng(seed);
  const model = new InverseModel(data, { isMale, correctInconsistency });
  const bounds = new Map();
  for (const [name, spec] of Object.entries(targets || {})) {
    bounds.set(model.nameToFlat.get(name), normalizeTarget(spec));
  }

  const order = slackItems.slice();
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  model.reset(out);
  for (const item of order) {
    if (rng() >= 0.5) continue;
    const touched = model._touched(item);
    const before = new Map();
    for (const flat of touched) before.set(flat, model.ts[flat]);
    model._mutate(item);
    for (const flat of touched) model.ts[flat] = model._computeT(flat);
    let ok = true;
    for (const [flat, spec] of bounds) {
      if (distanceOutside(model.ts[flat], spec) !== 0) {
        ok = false;
        break;
      }
    }
    if (ok) {
      out[item - 1] = !out[item - 1];
    } else {
      model._mutate(item);
      for (const [flat, value] of before) model.ts[flat] = value;
    }
  }
  return out;
}

/** 569-line CSV, the format mmpi2/grader.py reads back. */
export function answersToCsv(answers, options = {}) {
  const { isMale = true, lastName = '', firstName = '', age = '', date = '' } = options;
  const lines = [
    [lastName, firstName, age, date].join(','),
    isMale ? 'Male' : 'Female',
  ];
  for (const answer of answers) lines.push(answer ? 'True' : 'False');
  return `${lines.join('\r\n')}\r\n`;
}

/** Compact 567-character T/F string. */
export function answersToCompact(answers) {
  return answers.map((a) => (a ? 'T' : 'F')).join('');
}

/** For attribute values: item texts contain quotes and ampersands. */
function escapeAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Same idea, but for element content rather than an attribute value. */
function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Human-readable count of how many answer sheets realise the profile. */
export function combinationLabel(n) {
  if (n === 0) return '唯一解（无自由题）';
  if (n <= 48) return `${(2 ** n).toLocaleString('en-US')} 种组合`;
  return `约 10^${(n * Math.log10(2)).toFixed(0)} 种组合`;
}

/**
 * Parse bulk target lines.  Four shapes, one per mode:
 *
 *   Hs=70      Hs 70      Hs:70        exact
 *   Hs=65-75   Hs 65~75   Hs:65..75    range
 *   Hs>=65     Hs>65      Hs≥65        at least
 *   Hs<=70     Hs<70      Hs≤70        at most
 *
 * Values outside the T table are reported, not silently rejected.  A point
 * target comes back as a plain number; everything else as {lo, hi}.
 */
const TARGET_PATTERNS = [
  { kind: 'range', re: /^([A-Za-z0-9_]+)\s*(?::|=|\s)\s*(\d{1,3})\s*(?:-|~|–|—|\.{2})\s*(\d{1,3})$/ },
  { kind: 'atLeast', re: /^([A-Za-z0-9_]+)\s*(?:>=|≥|>)\s*(\d{1,3})$/ },
  { kind: 'atMost', re: /^([A-Za-z0-9_]+)\s*(?:<=|≤|<)\s*(\d{1,3})$/ },
  { kind: 'point', re: /^([A-Za-z0-9_]+)\s*(?::|=|\s)\s*(\d{1,3})$/ },
];

function matchTarget(token) {
  for (const { kind, re } of TARGET_PATTERNS) {
    const m = token.match(re);
    if (!m) continue;
    if (kind === 'range') return { kind, name: m[1], lo: Number(m[2]), hi: Number(m[3]) };
    if (kind === 'atMost') return { kind, name: m[1], hi: Number(m[2]) };
    return { kind, name: m[1], lo: Number(m[2]) };
  }
  return null;
}

export function parseBulkTargets(text, options = {}) {
  const { isMale = true, data = MMPI2_DATA } = options;
  const reachable = data.reachable[isMale ? 'male' : 'female'];
  const lookup = new Map(data.scales.map((slot) => [slot.name.toLowerCase(), slot.name]));

  const targets = {};
  const unknown = [];
  const unreachable = [];
  for (const chunk of String(text).split(/[\n,;]+/)) {
    const token = chunk.trim();
    if (!token) continue;
    const m = matchTarget(token);
    const name = m && lookup.get(m.name.toLowerCase());
    if (!name) {
      unknown.push(token);
      continue;
    }
    const info = reachable[name];
    const check = (label, value) => {
      if (info.values.includes(value)) return;
      const prefix = label ? `${label} ` : '';
      unreachable.push(`${name} ${prefix}${value} → ${nearestReachable(info.values, value)}`);
    };

    if (m.kind === 'point') {
      check('', m.lo);
      targets[name] = m.lo;
    } else if (m.kind === 'range') {
      check('下限', m.lo);
      check('上限', m.hi);
      targets[name] = { lo: Math.min(m.lo, m.hi), hi: Math.max(m.lo, m.hi) };
    } else if (m.kind === 'atLeast') {
      check('下限', m.lo);
      targets[name] = { lo: m.lo, hi: info.max };
    } else {
      check('上限', m.hi);
      targets[name] = { lo: info.min, hi: m.hi };
    }
  }
  return { targets, unknown, unreachable };
}

/** "70" / "65–75" / "≥ 65" / "≤ 70" -- needs the option for min / max. */
export function formatTarget(spec, option = null) {
  const t = normalizeTarget(spec);
  if (!t) return '—';
  if (t.lo === t.hi) return `${t.lo}`;
  const openLow = !option || t.lo <= option.min;
  const openHigh = !option || t.hi >= option.max;
  if (openLow && openHigh) return '不限';
  if (openHigh) return `≥ ${t.lo}`;
  if (openLow) return `≤ ${t.hi}`;
  return `${t.lo}–${t.hi}`;
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const state = {
  scale: 'mmpi2', // 'mmpi2' | 'scl90'
  isMale: true,
  correctInconsistency: false,
  iterations: ITERATION_PRESETS.standard,
  seed: 1,
  // targets[name] is always an interval {lo, hi}; a point target has lo === hi
  mode: 'exact',
  targets: {},
  options: {},
  plan: null,
  answers: null,
  freedom: null,
  slack: null,
};

/** 当前激活量表的数据对象（MMPI-2 / SCL-90 共用）。 */
function currentData() {
  return state.scale === 'scl90' ? SCL90_DATA : MMPI2_DATA;
}
const isScl90 = () => state.scale === 'scl90';

let dom = {};

/**
 * Every raw score the VRIN / TRIN item pairs can actually produce.
 *
 * Neither counting is free to range over 0..67 / -14..32:
 *
 *   - VRIN lists 67 pairs but only 49 distinct ones -- 18 pairs appear twice,
 *     usually with opposite expected patterns ((6,90) must be T/F for one copy
 *     and F/T for the other), so a pair can contribute 0 or 1 credits, not 2.
 *     Consistency therefore tops out well below 67, which under the corrected
 *     formula means the inconsistency count has a floor and low T scores
 *     (31..96 on the male table) are unreachable.
 *   - TRIN's 14 true-pairs and 9 false-pairs share three pairs (65/95,
 *     125/195, 359/367), and those contribute to bothTrue or bothFalse but
 *     never both.  Under the original formula raw = 9 + bothTrue + bothFalse
 *     can never drop below 9, hiding the whole 64..99 branch of the V-shaped
 *     table.
 *
 * The distinct pairs are item-disjoint (98 items for VRIN's 49 pairs, 40 for
 * TRIN's 23), so a small DP over pairs is exact.
 */
export function inconsistencyRawSet(name, isMale, correctInconsistency, data = MMPI2_DATA) {
  const resp = data.response;
  const tables = (isMale ? data.male : data.female).tables;
  const table = tables[4][name === 'VRIN' ? 5 : 6];

  const groups = new Map(); // item pair -> {nVrin?, nTrue, nFalse, copies}
  const groupOf = (a, b) => {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (!groups.has(key)) groups.set(key, { copies: [], nTrue: 0, nFalse: 0 });
    return groups.get(key);
  };

  if (name === 'VRIN') {
    for (let j = 0; j < resp.vrinPairs.length; j += 2) {
      groupOf(resp.vrinPairs[j], resp.vrinPairs[j + 1]).copies.push([
        resp.vrinExpected[j],
        resp.vrinExpected[j + 1],
      ]);
    }
    let totals = new Set([0]);
    for (const group of groups.values()) {
      const credits = new Set(
        [[false, false], [false, true], [true, false], [true, true]].map(
          ([a, b]) => group.copies.filter(([ea, eb]) => a === ea && b === eb).length
        )
      );
      const next = new Set();
      for (const total of totals) for (const credit of credits) next.add(total + credit);
      totals = next;
    }
    const nPairs = resp.vrinPairs.length / 2;
    return new Set([...totals].map((t) => (correctInconsistency ? nPairs - t : t)));
  }

  for (let j = 0; j < resp.truePairs.length; j += 2) {
    groupOf(resp.truePairs[j], resp.truePairs[j + 1]).nTrue += 1;
  }
  for (let j = 0; j < resp.falsePairs.length; j += 2) {
    groupOf(resp.falsePairs[j], resp.falsePairs[j + 1]).nFalse += 1;
  }
  let states = new Set(['0:0']);
  for (const group of groups.values()) {
    const options = [[0, 0]];
    if (group.nTrue) options.push([group.nTrue, 0]); // answer both True
    if (group.nFalse) options.push([0, group.nFalse]); // answer both False
    const next = new Set();
    for (const state of states) {
      const [tt, ff] = state.split(':').map(Number);
      for (const [dt, df] of options) next.add(`${tt + dt}:${ff + df}`);
    }
    states = next;
  }
  return new Set(
    [...states].map((state) => {
      const [tt, ff] = state.split(':').map(Number);
      return correctInconsistency ? 9 + tt - ff : 9 + tt + ff;
    })
  );
}

/** T values a scale can produce under the selected VRIN / TRIN formula. */
export function reachableValuesFor(name, isMale, correctInconsistency, data = MMPI2_DATA) {
  const info = data.reachable[isMale ? 'male' : 'female'][name];
  if (name !== 'VRIN' && name !== 'TRIN') return info.values;
  const table = (isMale ? data.male : data.female).tables[4][name === 'VRIN' ? 5 : 6];
  const values = new Set();
  for (const raw of inconsistencyRawSet(name, isMale, correctInconsistency, data)) {
    values.add(0 <= raw && raw < table.length ? table[raw] : table[table.length - 1]);
  }
  return [...values].sort((a, b) => a - b);
}

/** Consistency count for VRIN closest to what a target T score needs. */
function wantedConsistency(target, isMale, correctInconsistency, data) {
  const table = (isMale ? data.male : data.female).tables[4][5];
  const ideal = table.indexOf(target);
  if (ideal === -1) return 0;
  const raws = [...inconsistencyRawSet('VRIN', isMale, correctInconsistency, data)];
  const best = raws.reduce(
    (a, b) => (Math.abs(b - ideal) < Math.abs(a - ideal) ? b : a),
    raws[0]
  );
  const pairs = data.response.vrinPairs.length / 2;
  return correctInconsistency ? pairs - best : best;
}

function optionsFor(isMale, correct) {
  const key = `${isMale ? 'male' : 'female'}|${correct ? 'fixed' : 'legacy'}`;
  if (!state.options[key]) {
    const options = scaleOptions({ isMale });
    const trin = options.find((o) => o.name === 'TRIN');
    trin.values = reachableValuesFor('TRIN', isMale, correct);
    trin.min = trin.values[0];
    trin.max = trin.values[trin.values.length - 1];
    trin.gaps = trin.values.filter((v, i) => i > 0 && v - trin.values[i - 1] > 1).length
      ? [...Array(trin.max - trin.min + 1).keys()]
          .map((i) => i + trin.min)
          .filter((v) => !trin.values.includes(v))
      : [];
    trin.sparse = trin.gaps.length > 0;
    state.options[key] = options;
  }
  return state.options[key];
}

/* -- scale pickers -------------------------------------------------- */

/** The select(s) a row needs in the current mode. */
function modeEdges(mode) {
  return TARGET_MODES.find((m) => m.id === mode)?.edges || ['point'];
}

function buildScaleList() {
  if (isScl90()) return buildScl90ScaleList();
  const byFamily = new Map(FAMILY_ORDER.map((f) => [f, []]));
  for (const option of optionsFor(state.isMale, state.correctInconsistency)) {
    byFamily.get(option.family).push(option);
  }
  const edges = modeEdges(state.mode);
  const two = edges.length === 2;

  const html = FAMILY_ORDER.map((family) => {
    const rows = byFamily.get(family)
      .map((option) => {
        const current = normalizeTarget(state.targets[option.name]) || { lo: null, hi: null };
        const picker = (edge) => {
          const selected = edge === 'hi' ? current.hi : current.lo;
          const values = option.values
            .map((v) => `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`)
            .join('');
          return `<select data-name="${option.name}" data-edge="${edge}"` +
            `${edge === 'lo' ? ' title="下限"' : edge === 'hi' ? ' title="上限"' : ''}>` +
            `<option value="">—</option>${values}</select>`;
        };
        const cn = cnName(option.name);
        return (
          `<div class="row" data-name="${option.name}"` +
          ` data-search="${option.name.toLowerCase()} ${option.fullName.toLowerCase()} ${cn.toLowerCase()}">` +
          `<span class="abbr" title="${option.fullName}${cn ? ' ' + cn : ''}">${option.name}</span>` +
          edges.map(picker).join('') +
          `<span class="full">${option.fullName}${cn ? ` <span class="cn">${cn}</span>` : ''}</span></div>`
        );
      })
      .join('');
    const open = family === 'basic' ? ' open' : '';
    return (
      `<details class="group"${open}><summary>${FAMILY_LABELS[family]}` +
      `<span class="count">${byFamily.get(family).length}</span></summary>` +
      `<div class="rows${two ? ' two' : ''}">${rows}</div></details>`
    );
  }).join('');

  dom.scaleList.innerHTML = html;
  for (const select of dom.scaleList.querySelectorAll('select')) {
    select.addEventListener('change', onTargetChanged);
  }
  applySearch();
}

/** What the pickers say, completed with the open bound of the current mode. */
function collectTargets() {
  const byName = new Map(optionsFor(state.isMale, state.correctInconsistency).map((o) => [o.name, o]));
  const picked = new Map();
  for (const select of dom.scaleList.querySelectorAll('select')) {
    if (select.value === '') continue;
    const name = select.dataset.name;
    const edge = select.dataset.edge || 'point';
    const value = Number(select.value);
    const entry = picked.get(name) || { lo: null, hi: null };
    if (edge === 'point') {
      entry.lo = value;
      entry.hi = value;
    } else if (edge === 'lo') {
      entry.lo = value;
    } else {
      entry.hi = value;
    }
    picked.set(name, entry);
  }

  const targets = {};
  for (const [name, entry] of picked) {
    const option = byName.get(name);
    const lo = entry.lo === null
      ? (state.mode === 'atMost' && option ? option.min : entry.hi)
      : entry.lo;
    const hi = entry.hi === null
      ? (state.mode === 'atLeast' && option ? option.max : entry.lo)
      : entry.hi;
    targets[name] = { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
  }
  return targets;
}

function applyTargets(targets) {
  const byName = new Map(optionsFor(state.isMale, state.correctInconsistency).map((o) => [o.name, o]));
  const notes = [];
  for (const [name, spec] of Object.entries(targets)) {
    const option = byName.get(name);
    if (!option) continue;
    const interval = normalizeTarget(spec);
    const lo = snapTo(option.values, interval.lo);
    const hi = snapTo(option.values, interval.hi);
    if (lo !== interval.lo || hi !== interval.hi) {
      notes.push(`${name}: ${formatTarget(interval, option)} → ${formatTarget({ lo, hi }, option)}`);
    }
    state.targets[name] = { lo, hi };
  }
  if (notes.length) setNote(`目标值已折算到可取値：${notes.join('，')}`);
  buildScaleList();
}

/** Keep targets valid when the gender or the VRIN / TRIN formula changes. */
function retarget(targets) {
  const byName = new Map(optionsFor(state.isMale, state.correctInconsistency).map((o) => [o.name, o]));
  const kept = {};
  const notes = [];
  for (const [name, spec] of Object.entries(targets)) {
    const option = byName.get(name);
    if (!option) continue;
    const interval = normalizeTarget(spec);
    const lo = snapTo(option.values, interval.lo);
    const hi = snapTo(option.values, interval.hi);
    if (lo !== interval.lo || hi !== interval.hi) {
      notes.push(`${name}: ${formatTarget(interval, option)} → ${formatTarget({ lo, hi }, option)}`);
    }
    kept[name] = { lo, hi };
  }
  if (notes.length) setNote(`目标値已折算到当前 T 表的可取値：${notes.join('，')}`);
  return kept;
}

/**
 * Restate every target in a new mode: a range collapses to its midpoint, an
 * exact value opens up to the next value above it, and the two one-sided modes
 * take the far end from the scale's own table.
 */
export function convertTargets(targets, mode, options) {
  const byName = new Map((options || []).map((o) => [o.name, o]));
  const out = {};
  for (const [name, spec] of Object.entries(targets)) {
    const option = byName.get(name);
    if (!option) continue;
    const interval = normalizeTarget(spec);
    const value = interval.lo === interval.hi
      ? interval.lo
      : snapTo(option.values, targetPoint(interval, option.values));
    if (mode === 'range') {
      const above = option.values.find((v) => v > value);
      out[name] = { lo: value, hi: above === undefined ? value : above };
    } else if (mode === 'atLeast') {
      out[name] = { lo: value, hi: option.max };
    } else if (mode === 'atMost') {
      out[name] = { lo: option.min, hi: value };
    } else {
      out[name] = { lo: value, hi: value };
    }
  }
  return out;
}

function onTargetChanged(event) {
  const name = event.target.dataset.name;
  if (event.target.value === '') {
    delete state.targets[name];
    refreshSolveButton();
    return;
  }
  const value = Number(event.target.value);
  if (isScl90()) {
    // SCL-90 的目标就是因子均分，直接作为点目标
    state.targets[name] = { lo: value, hi: value };
    refreshSolveButton();
    return;
  }
  const edge = event.target.dataset.edge || 'point';
  const option = optionsFor(state.isMale, state.correctInconsistency)
    .find((o) => o.name === name);
  const current = normalizeTarget(state.targets[name]);

  let lo = value;
  let hi = value;
  if (state.mode === 'range') {
    if (edge === 'lo') {
      lo = value;
      hi = current ? Math.max(current.hi, value) : value;
    } else {
      hi = value;
      lo = current ? Math.min(current.lo, value) : value;
    }
  } else if (state.mode === 'atLeast') {
    lo = value;
    hi = option ? option.max : value;
  } else if (state.mode === 'atMost') {
    hi = value;
    lo = option ? option.min : value;
  }
  state.targets[name] = { lo, hi };
  refreshSolveButton();
}

function applySearch() {
  const needle = dom.search.value.trim().toLowerCase();
  for (const row of dom.scaleList.querySelectorAll('.row')) {
    row.hidden = needle !== '' && !row.dataset.search.includes(needle);
  }
  for (const group of dom.scaleList.querySelectorAll('.group')) {
    const visible = [...group.querySelectorAll('.row')].some((row) => !row.hidden);
    group.hidden = !visible;
    if (needle !== '') group.open = true;
  }
}

/* -- results -------------------------------------------------------- */

function refreshSolveButton() {
  dom.solve.disabled = Object.keys(state.targets).length === 0;
  dom.again.disabled = !state.plan;
  dom.shuffle.disabled = !state.plan;
  dom.copy.disabled = !state.answers;
  dom.csv.disabled = !state.answers;
}

function setNote(text) {
  dom.note.textContent = text || '';
  dom.note.hidden = !text;
}

function runPlan({ newSeed = false } = {}) {
  const targets = collectTargets();
  if (!Object.keys(targets).length) {
    setNote(
      isScl90()
        ? '请先在左侧为每个因子选择目标严重度（或直接导入作答）。'
        : '请先在左侧选择至少一个量表的目标 T 分。'
    );
    return;
  }
  if (isScl90()) {
    runScl90Plan(targets);
    return;
  }
  if (newSeed) state.seed = (state.seed * 1103515245 + 12345) % 2147483647;

  dom.status.textContent = '计算中…';
  dom.status.className = 'status busy';
  // let the browser paint "计算中…" before the synchronous search blocks
  setTimeout(() => {
    const started = Date.now();
    let plan;
    try {
      plan = planSheet({
        targets,
        isMale: state.isMale,
        correctInconsistency: state.correctInconsistency,
        iterations: state.iterations,
        seed: state.seed,
      });
    } catch (error) {
      dom.status.textContent = `求解失败：${error.message}`;
      dom.status.className = 'status bad';
      return;
    }
    state.plan = plan;
    state.answers = plan.answers.slice();
    state.freedom = plan.freedom;
    state.slack = plan.slack;
    renderStatus(plan, Date.now() - started);
    renderTargetTable(plan);
    renderProfile(plan.profile);
    renderAnswers(plan);
    renderItemBank();
    dom.results.hidden = false;
    refreshSolveButton();
  }, 30);
}

function renderStatus(plan, ms) {
  const byName = new Map(optionsFor(state.isMale, state.correctInconsistency).map((o) => [o.name, o]));
  const off = Object.entries(plan.residual).filter(([, v]) => v !== 0);
  const snapped = Object.entries(plan.requested).filter(
    ([name, value]) => JSON.stringify(plan.target[name]) !== JSON.stringify(value)
  );
  const count = Object.keys(plan.target).length;
  if (plan.feasible) {
    dom.status.textContent = plan.hasRange
      ? `${count} 个目标全部落在预期区间内（耗时 ${ms} ms）。`
      : `完全命中 ${count} 个目标（耗时 ${ms} ms）。`;
    dom.status.className = 'status ok';
  } else {
    dom.status.textContent =
      `无法同时满足全部目标（总偏差 ${plan.loss}，耗时 ${ms} ms）：` +
      off.map(([name, value]) => `${name} ${value > 0 ? '+' : ''}${value}`).join('，') +
      '。量表间题目重叠，可放宽个别目标或提高强度重试。';
    dom.status.className = 'status bad';
  }
  if (snapped.length) {
    setNote(
      '以下目标不在 T 表可取値内，已折算：' +
        snapped
          .map(
            ([name, value]) =>
              `${name} ${formatTarget(value, byName.get(name))} → ` +
              `${formatTarget(plan.target[name], byName.get(name))}`
          )
          .join('，')
    );
  }
}

function renderTargetTable(plan) {
  const byName = new Map(optionsFor(state.isMale, state.correctInconsistency).map((o) => [o.name, o]));
  const rows = Object.keys(plan.target)
    .map((name) => {
      const gap = plan.residual[name];
      const got = plan.achieved[name];
      const tCN = cnT(name, got, plan.isMale);
      // 29 scales have Chinese parameters.  The rest must show as unknown --
      // never as a plausible-looking number.
      const cnCell = tCN === null
        ? '<td class="dim" title="该量表没有已出版的中国常模参数">—</td>'
        : `<td class="${tCN >= MMPI2_DATA.cnNorms.cutoffCN ? 'hot' : ''}"` +
          ` title="中国 ${MMPI2_DATA.cnNorms.cutoffCN} 分界点 = 美国 ` +
          `${usTForCn60(name, plan.isMale).toFixed(1)} 分">${tCN}</td>`;
      const cls = gap === 0 ? 'ok' : 'bad';
      const label = formatTarget(plan.bounds[name], byName.get(name));
      const same = JSON.stringify(plan.requested[name]) === JSON.stringify(plan.target[name]);
      const want = same
        ? label
        : `${formatTarget(plan.requested[name], byName.get(name))} → ${label}`;
      const gapTitle = gap === 0
        ? '落在预期区间内'
        : gap < 0
          ? `低于下限 ${-gap} 分`
          : `高于上限 ${gap} 分`;
      const cnScale = cnName(name);
      return (
        `<tr class="${cls}"><td class="abbr" title="${byName.get(name).fullName}${cnScale ? ' ' + cnScale : ''}">${name}</td><td>${want}</td>` +
        `<td>${got}</td>${cnCell}` +
        `<td title="${gapTitle}">${gap === 0 ? '0' : (gap > 0 ? '+' : '') + gap}</td></tr>`
      );
    })
    .join('');
  dom.targetTable.innerHTML =
    `<thead><tr><th>量表</th><th>目标</th><th>达成（美国 T）</th>` +
    `<th>近似中国 T</th><th>偏差</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderProfile(profile) {
  const byFamily = new Map(FAMILY_ORDER.map((f) => [f, []]));
  for (const slot of MMPI2_DATA.scales) byFamily.get(MMPI2_DATA.families[slot.family]).push(slot);
  const raws = (state.plan && state.plan.rawByName) || (state.imported && state.imported.rawByName) || {};

  const html = FAMILY_ORDER.map((family) => {
    const rows = byFamily.get(family)
      .map((slot) => {
        const value = profile[slot.name];
        const raw = raws[slot.name];
        const cn = cnT(slot.name, value, state.isMale);
        const cnScale = cnName(slot.name);
        const targeted = state.targets[slot.name] !== undefined;
        const level = value >= 80 ? 'hi' : value >= 65 ? 'mid' : '';
        return (
          `<tr class="${targeted ? 'targeted' : ''}">` +
          `<td class="abbr" title="${slot.fullName}${cnScale ? ' ' + cnScale : ''}">${slot.name}</td>` +
          `<td class="full">${slot.fullName}${cnScale ? ` <span class="cn">${cnScale}</span>` : ''}</td>` +
          `<td class="raw">${raw === undefined ? '' : raw}</td>` +
          `<td class="t ${level}">${value}</td>` +
          `<td class="dim">${cn === null ? '—' : cn}</td>` +
          `<td>${targeted ? '目标' : ''}</td></tr>`
        );
      })
      .join('');
    return (
      `<div class="group"><h4>${FAMILY_LABELS[family]}</h4>` +
      `<table><thead><tr><th>量表</th><th>名称</th><th>原始分</th><th>美国 T</th>` +
      `<th>近似中国 T</th><th></th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div>`
    );
  }).join('');
  dom.profile.innerHTML = html;
}

/** The question text to show in a grid cell, following the 题干语言 picker. */
function questionHtml(text, lang) {
  if (lang === 'en') return escapeHtml(text.en);
  if (lang === 'both') {
    return `${escapeHtml(text.zh)}<span class="en">${escapeHtml(text.en)}</span>`;
  }
  return escapeHtml(text.zh);
}

/**
 * Recompute the free / slack split.  Needed whenever the answers changed under
 * the plan's feet -- a slack flip moves a targeted scale, so which items are
 * still flippable depends on where the profile sits now.
 */
function refreshFreedom() {
  if (!state.plan) return;
  if (isScl90()) return; // SCL-90 无锁定概念，全部自由
  const analysis = analyseFreedom(state.answers, state.plan.bounds, {
    isMale: state.isMale,
    correctInconsistency: state.correctInconsistency,
  });
  state.freedom = analysis.freedom;
  state.slack = analysis.slack;
  Object.assign(state.plan, {
    freeItems: analysis.freeItems,
    slackItems: analysis.slackItems,
    lockedItems: analysis.lockedItems,
    lockReason: analysis.lockReason,
  });
}

/* -- 多级作答滑杆 ---------------------------------------------------- */

// 滑轨分块配色：冷 → 暖。级别数不超过调色板长度时直接用调色板；
// 更长的量表（如 1~100）按色相线性插值，避免色板不够用。
const LEVEL_COLORS = ['#4caf7d', '#9ccc65', '#fbc02d', '#fb8c00', '#e53935', '#8e24aa', '#5e35b1'];

function levelColor(n, i) {
  if (n <= LEVEL_COLORS.length) return LEVEL_COLORS[i];
  const t = n <= 1 ? 0 : i / (n - 1);
  return `hsl(${Math.round(130 * (1 - t))} 72% 55%)`;
}

/** 生成滑轨背景：n 级切成 n 块，每块一个固定颜色（长量表用平滑渐变）。 */
function trackGradient(n) {
  if (n <= 20) {
    const stops = [];
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * 100;
      const b = ((i + 1) / n) * 100;
      stops.push(`${levelColor(n, i)} ${a.toFixed(3)}% ${b.toFixed(3)}%`);
    }
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }
  const stops = [];
  for (let k = 0; k <= 10; k += 1) {
    const t = k / 10;
    stops.push(`${levelColor(n, Math.round(t * (n - 1)))} ${(t * 100).toFixed(2)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/** 级别 -> 滑轨百分比位置（取块中心）。 */
function levelLeft(n, lvl) {
  return n <= 1 ? 0 : ((lvl + 0.5) / n) * 100;
}

/** 就地重绘某题滑杆的滑块与数值文本（拖动时用，避免整表重建）。 */
function paintSlider(cell, level, levels) {
  if (!cell) return;
  const n = levels.length;
  const thumb = cell.querySelector('.slide-thumb');
  if (thumb) thumb.style.left = `${levelLeft(n, level)}%`;
  const val = cell.querySelector('.slide-val');
  if (val) val.textContent = `${level + 1} · ${levels[level]?.label || ''}`;
  const track = cell.querySelector('.slide-track');
  if (track) track.setAttribute('aria-valuenow', String(level + 1));
}

/** 指针横坐标 -> 级别（按块取整）。 */
function sliderLevelAt(track, clientX) {
  const rect = track.getBoundingClientRect();
  const n = Number(track.dataset.n);
  const ratio = rect.width ? (clientX - rect.left) / rect.width : 0;
  return Math.min(n - 1, Math.max(0, Math.floor(ratio * n)));
}

// 滑杆拖动状态（同一时刻只拖一个）
let scl90Drag = null;

/** 提交某题的新级别：同因子内自动重分配，保持目标均值不变。 */
function commitScl90Item(item, startLevel) {
  if (!state.plan) return;
  const level = state.answers[item - 1];
  if (level === startLevel) return;
  state.answers = scl90SetItemLevel(state.answers, state.plan.target, item, level);
  state.plan.answers = state.answers;
  const scores = scl90Score(state.answers);
  state.plan.scores = scores;
  state.plan.profile = scores;
  renderScl90TargetTable(state.plan);
  renderScl90Profile(scores);
  renderAnswers(state.plan);
  renderItemBank();
}

/**
 * 指针按下：先只记录起点，不立即改值。
 * 触屏上允许纵向滑动页面（touch-action: pan-y），只有明显的横向拖动才接管。
 */
function onSliderDown(event) {
  const track = event.target.closest ? event.target.closest('.slide-track') : null;
  if (!track || !state.plan || !isScl90()) return;
  const item = Number(track.dataset.item);
  const n = Number(track.dataset.n);
  const levels = itemFormatDesc(currentData(), item).levels || [];
  const b = state.plan.itemBounds && state.plan.itemBounds[item]
    ? state.plan.itemBounds[item]
    : { lo: 0, hi: n - 1 };
  const lo = Math.max(0, Math.min(n - 1, b.lo));
  const hi = Math.max(lo, Math.min(n - 1, b.hi));
  scl90Drag = {
    item, track, n, levels, lo, hi,
    start: state.answers[item - 1],
    startX: event.clientX,
    startY: event.clientY,
    active: false,
    pointerId: event.pointerId,
  };
  try {
    track.setPointerCapture(event.pointerId);
  } catch {
    /* 旧浏览器没有指针捕获，退化为普通事件 */
  }
}

function onSliderMove(event) {
  if (!scl90Drag) return;
  const drag = scl90Drag;
  const { track, lo, hi, item, levels } = drag;
  if (!drag.active) {
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // 纵向意图超过横向：放行页面滚动，放弃这次拖动
    if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
      scl90Drag = null;
      return;
    }
    if (Math.abs(dx) < 6) return; // 还没形成横向拖动
    drag.active = true;
  }
  const level = Math.max(lo, Math.min(hi, sliderLevelAt(track, event.clientX)));
  if (level === state.answers[item - 1]) return;
  state.answers[item - 1] = level;
  paintSlider(track.closest('.cell'), level, levels);
}

function onSliderUp(event) {
  if (!scl90Drag) return;
  const drag = scl90Drag;
  scl90Drag = null;
  if (!drag.active) {
    // 未形成拖动，按一次点击处理：直接落到落点所在档
    const level = Math.max(drag.lo, Math.min(drag.hi, sliderLevelAt(drag.track, event.clientX)));
    state.answers[drag.item - 1] = level;
    paintSlider(drag.track.closest('.cell'), level, drag.levels);
  }
  commitScl90Item(drag.item, drag.start);
}

/** 键盘可访问：方向键 / Home / End 在可行区间内逐级调整。 */
function onSliderKey(event) {
  if (!isScl90() || !state.plan) return;
  const track = event.target.closest ? event.target.closest('.slide-track') : null;
  if (!track) return;
  const key = event.key;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
  event.preventDefault();
  const item = Number(track.dataset.item);
  const n = Number(track.dataset.n);
  const b = state.plan.itemBounds && state.plan.itemBounds[item]
    ? state.plan.itemBounds[item]
    : { lo: 0, hi: n - 1 };
  const lo = Math.max(0, Math.min(n - 1, b.lo));
  const hi = Math.max(lo, Math.min(n - 1, b.hi));
  const cur = state.answers[item - 1] ?? 0;
  let next = cur;
  if (key === 'ArrowLeft' || key === 'ArrowDown') next = cur - 1;
  else if (key === 'ArrowRight' || key === 'ArrowUp') next = cur + 1;
  else if (key === 'Home') next = lo;
  else if (key === 'End') next = hi;
  next = Math.max(lo, Math.min(hi, next));
  if (next === cur) return;
  state.answers[item - 1] = next;
  commitScl90Item(item, cur);
}

function renderAnswers(plan) {
  const parts = [];
  const showText = dom.showText ? dom.showText.checked : false;
  const lang = dom.textLang ? dom.textLang.value : 'zh';
  for (let item = 1; item <= currentData().nItems; item += 1) {
    const free = state.freedom[item];
    const slacky = !free && !!state.slack && state.slack[item];
    const answer = state.answers[item - 1] ? 'T' : 'F';
    const text = isScl90() ? scl90ItemText(item) : itemText(item);
    let title;
    if (isScl90()) {
      title = [text.zh, text.en].filter(Boolean).join('\n');
    } else {
      const reasons = plan.lockReason.get(item);
      title = [
        `第 ${item} 题：` + (free
          ? '自由（翻转不影响目标量表）'
          : slacky
            ? `区间内可翻转（翻转后目标仍全部落在区间内；会改动 ${(reasons || []).join('、')}）`
            : `锁定（翻转会改变 ${(reasons || []).join('、')}）`),
        text.zh,
        text.en,
      ].join('\n');
    }
    const desc = itemFormatDesc(currentData(), item);
    if (desc.type === 'binary') {
      // TF：保持原结构（测试依赖 .cell > b 与 data-item）
      parts.push(
        `<div class="cell ${free ? 'free' : 'locked'}${slacky ? ' slack' : ''} ` +
          `${answer === 'T' ? 'is-t' : 'is-f'}"` +
          ` data-item="${item}" title="${escapeAttr(title)}">` +
          `<span class="n">${item}</span><b>${answer}</b>` +
          (showText ? `<span class="q">${questionHtml(text, lang)}</span>` : '') +
          '</div>'
      );
    } else {
      // 多级作答（Likert / Choice）：滑杆，滑轨按选项数分块着色
      const levels = desc.levels;
      const n = levels.length;
      const lvl = Math.max(0, Math.min(n - 1, state.answers[item - 1] ?? 0));
      const b = isScl90() && plan.itemBounds && plan.itemBounds[item]
        ? plan.itemBounds[item]
        : { lo: 0, hi: n - 1 };
      const lo = Math.max(0, Math.min(n - 1, b.lo));
      const hi = Math.max(lo, Math.min(n - 1, b.hi));
      const markLeft = n <= 1 ? 0 : (lo / n) * 100;
      const markWidth = n <= 1 ? 100 : ((hi - lo + 1) / n) * 100;
      parts.push(
        `<div class="cell slide ${free ? 'free' : 'locked'}" data-item="${item}" title="${escapeAttr(title)}">` +
          `<div class="slide-top"><span class="n">${item}</span>` +
          `<span class="slide-val">${lvl + 1} · ${escapeHtml(levels[lvl]?.label || '')}</span></div>` +
          `<div class="slide-track" data-item="${item}" data-n="${n}" role="slider" tabindex="0" ` +
            `aria-label="第 ${item} 题" aria-valuemin="1" aria-valuemax="${n}" aria-valuenow="${lvl + 1}" ` +
            `aria-valuetext="${escapeAttr(levels[lvl]?.label || '')}" ` +
            `style="background:${trackGradient(n)}">` +
            `<span class="slide-mark" style="left:${markLeft}%;width:${markWidth}%"></span>` +
            `<span class="slide-thumb" style="left:${levelLeft(n, lvl)}%"></span>` +
          '</div>' +
          (showText ? `<span class="q">${questionHtml(text, lang)}</span>` : '') +
        '</div>'
      );
    }
  }
  dom.answers.innerHTML = parts.join('');
  dom.answers.classList.toggle('with-text', showText);
  if (isScl90()) {
    let freeN = 0;
    let lockN = 0;
    const b = plan.itemBounds;
    if (b) {
      for (let i = 1; i <= currentData().nItems; i += 1) {
        if (b[i].lo < b[i].hi) freeN += 1;
        else lockN += 1;
      }
    } else {
      freeN = plan.freeItems ? plan.freeItems.length : 0;
      lockN = plan.lockedItems ? plan.lockedItems.length : 0;
    }
    dom.freeCount.textContent = `锁定 ${lockN} 题 · 区间可调 ${freeN} 题`;
  } else {
    const slackCount = plan.slackItems ? plan.slackItems.length : 0;
    dom.freeCount.textContent =
      `自由题 ${plan.freeItems.length} 道 · ${combinationLabel(plan.freeItems.length)}` +
      (slackCount ? `；另有 ${slackCount} 道在区间内可翻转` : '');
  }
}

/**
 * The whole 567-item bank: original English wording, Chinese translation, the
 * answer the current sheet gives and whether that item is free or locked.
 * Also works before solving -- then the last two columns stay blank.
 */
function renderItemBank() {
  if (!dom.bankTable) return;
  const total = isScl90() ? SCL90_DATA.nItems : MMPI2_DATA.nItems;
  const filter = dom.bankFilter ? dom.bankFilter.value : 'all';
  const plan = state.plan;

  if (filter !== 'all' && !plan) {
    dom.bankTable.innerHTML =
      '<tbody><tr><td class="dim">先生成答卷，才能按回答或锁定状态筛选题目。</td></tr></tbody>';
    if (dom.bankCount) dom.bankCount.textContent = `显示 0 / ${total} 题`;
    return;
  }

  const needle = (dom.bankSearch.value || '').trim().toLowerCase();
  const rows = [];
  let shown = 0;
  for (let item = 1; item <= total; item += 1) {
    const text = isScl90() ? scl90ItemText(item) : itemText(item);
    if (needle &&
        String(item) !== needle &&
        !(text.en || '').toLowerCase().includes(needle) &&
        !text.zh.toLowerCase().includes(needle)) continue;
    const answer = state.answers
      ? (isScl90() ? levelToScore(state.answers[item - 1]) : (state.answers[item - 1] ? 'T' : 'F'))
      : null;
    const bound = plan && isScl90() && plan.itemBounds ? plan.itemBounds[item] : null;
    const free = plan
      ? (isScl90() ? (bound ? bound.lo < bound.hi : true) : !!state.freedom[item])
      : null;
    if (filter === 'free' && !free) continue;
    if (filter === 'locked' && free !== false) continue;
    if (filter === 't' && answer !== 'T') continue;
    if (filter === 'f' && answer !== 'F') continue;
    let statusText = '—';
    if (free !== null) {
      if (isScl90()) {
        statusText = free
          ? (bound ? `可调 ${bound.lo + 1}–${bound.hi + 1}` : '可调')
          : (bound ? `锁定 ${bound.lo + 1}` : '锁定');
      } else {
        statusText = free ? '自由' : '锁定';
      }
    }
    shown += 1;
    rows.push(
      `<tr data-item="${item}" class="${free === false ? 'locked' : ''}">` +
      `<td class="n">${item}</td>` +
      `<td class="orig">${escapeHtml(text.en)}</td>` +
      `<td class="zh">${escapeHtml(text.zh)}</td>` +
      `<td class="ans ${answer === null ? 'dim' : answer === 'T' ? 'is-t' : isScl90() ? 'is-lvl' : 'is-f'}">${answer || '—'}</td>` +
      `<td class="st ${free === null ? 'dim' : free ? 'free' : 'locked'}">${statusText}</td>` +
      '</tr>'
    );
  }
  dom.bankTable.innerHTML =
    '<thead><tr><th>题号</th><th>英文原文</th><th>中文</th><th>回答</th><th>状态</th></tr></thead>' +
    `<tbody>${rows.join('')}</tbody>`;
  if (dom.bankCount) {
    dom.bankCount.textContent = `显示 ${shown} / ${total} 题` +
      (plan ? '' : '（生成答卷后可看回答与锁定状态）');
  }
}

// 触屏长按弹出提示后，紧随的 click 要被吃掉，避免把「锁定题解释」误当成翻转
let suppressClick = false;

function onAnswerClick(event) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const cell = event.target.closest('.cell');
  if (!cell || !state.plan) return;
  const item = Number(cell.dataset.item);
  // 多级作答：点击具体级别按钮直接设定该级别（TF 无 [data-level]，走下方翻转）
  const lvlBtn = event.target.closest('[data-level]');
  if (lvlBtn) {
    const level = Number(lvlBtn.dataset.level);
    if (state.answers[item - 1] === level) return;
    state.answers[item - 1] = level;
    if (isScl90()) {
      renderAnswers(state.plan);
      renderScl90Profile(scl90Score(state.answers));
      renderItemBank();
    } else {
      refreshFreedom();
      renderAnswers(state.plan);
      renderProfile(scoreAnswers(state.answers, {
        isMale: state.isMale,
        correctInconsistency: state.correctInconsistency,
      }).byName);
      renderItemBank();
    }
    return;
  }
  if (isScl90()) return; // 多级量表只认级别按钮
  const isFree = cell.classList.contains('free');
  const isSlack = cell.classList.contains('slack');
  if (!isFree && !isSlack) return;
  state.answers[item - 1] = !state.answers[item - 1];
  const answer = state.answers[item - 1] ? 'T' : 'F';
  cell.querySelector('b').textContent = answer;
  cell.classList.toggle('is-t', state.answers[item - 1]);
  cell.classList.toggle('is-f', !state.answers[item - 1]);
  if (isSlack) {
    // the flip moved a targeted scale, so the free / slack split is stale
    refreshFreedom();
    renderAnswers(state.plan);
  }
  renderProfile(
    scoreAnswers(state.answers, {
      isMale: state.isMale,
      correctInconsistency: state.correctInconsistency,
    }).byName
  );
  renderItemBank();
}

/**
 * Touch fallback for the hover-only `title` tooltips: a long press (≈450ms,
 * finger held still) shows the title in a floating bubble.  Short taps still
 * behave as clicks.  We also kill the native callout / text-selection that a
 * long press would otherwise trigger on mobile, so the bubble is the only
 * thing that appears.
 */
function setupLongPressTips() {
  if (typeof document === 'undefined' || !('ontouchstart' in window)) return;
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  const LONG = 450;
  const MOVE = 10;
  let timer = null;
  let target = null;
  let x0 = 0;
  let y0 = 0;
  let pinned = false; // 长按抬起后气泡保持显示，直到下次触摸 / 滚动

  const hide = () => { tip.style.display = 'none'; pinned = false; };
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const show = (el) => {
    const text = el.getAttribute('title');
    if (!text) return;
    tip.textContent = text;
    tip.style.display = 'block';
    tip.style.visibility = 'hidden';
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - th - 8));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = 'visible';
  };

  document.addEventListener('touchstart', (e) => {
    if (pinned) hide(); // 上一次的提示先收起
    const el = e.target.closest('[title]');
    if (!el || el.closest('select, input, textarea, button, a')) return;
    target = el;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      pinned = true;
      suppressClick = true;
      show(el);
      // 让紧随其后的 click 被忽略后，标记自动复位，避免吃掉下一次正常点击
      setTimeout(() => { suppressClick = false; }, 350);
    }, LONG);
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!target) return;
    const dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;
    if (Math.hypot(dx, dy) > MOVE) { clearTimer(); hide(); target = null; }
  }, { passive: true });

  const end = () => { clearTimer(); target = null; if (!pinned) hide(); };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
  // 滚动时收起，避免气泡悬在别处
  document.addEventListener('scroll', hide, { passive: true });
  // 阻止长按弹出的系统菜单 / 文本选择
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[title]')) e.preventDefault();
  });
}

/* -- actions -------------------------------------------------------- */

function download(filename, text, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Same as download(), but for the Uint8Array an .xlsx comes back as. */
function downloadBytes(filename, bytes, mime) {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildExportPanel() {
  if (!dom.exportContents) return;
  const items = isScl90()
    ? [
        { id: 'answers', label: '答题表（90 题 × 题干 / 得分 / 程度）' },
        { id: 'profile', label: '因子剖面（9 临床因子 + 其他 + 总分）' },
        { id: 'targets', label: '因子均分达成（偏差）' },
        { id: 'template', label: '空白答题模板（供真人作答）' },
      ]
    : EXPORT_CONTENTS;
  dom.exportContents.innerHTML = items
    .map(
      (item) =>
        `<label class="check"><input type="checkbox" data-content="${item.id}"` +
        `${item.id === 'answers' ? ' checked' : ''}>${item.label}</label>`
    )
    .join('');
  dom.exportFormat.innerHTML = EXPORT_FORMATS.map(
    (item) => `<option value="${item.id}">${item.label}</option>`
  ).join('');
}

function runExport() {
  if (isScl90()) {
    if (!state.answers) {
      setNote('请先生成或导入一份 SCL-90 答卷。');
      return;
    }
    const scores = scl90Score(state.answers);
    const lines = ['题号,得分,程度'];
    for (let i = 0; i < SCL90_DATA.nItems; i += 1) {
      const lvl = state.answers[i];
      const sc = levelToScore(lvl);
      const lab = SCL90_DATA.formats.likert5.levels[lvl]?.label || '';
      lines.push(`${i + 1},${sc},${lab}`);
    }
    lines.push('', '因子,均分/总分,解释');
    for (const f of SCL90_DATA.scales) {
      const val = f.bind[0] === 0
        ? f.type === 'sum' ? scores.total : scores.totalMean.toFixed(2)
        : scores.factors[f.name].mean.toFixed(2);
      const sev = scores.diagnoses[f.name] ? scores.diagnoses[f.name].severity : '';
      lines.push(`${f.name},${val},${sev}`);
    }
    download('scl90-export.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
    setNote(`已导出 scl90-export.csv（90 题 + 12 维度剖面）。`);
    return;
  }
  const picked = [...dom.exportContents.querySelectorAll('input[data-content]')]
    .filter((input) => input.checked)
    .map((input) => input.dataset.content);
  if (!picked.length) {
    setNote('至少勾选一项导出内容。');
    return;
  }
  const sheets = buildSheets(state.plan, {
    content: picked,
    withEnglish: dom.exportEnglish.checked,
    withLockInfo: true,
    data: isScl90() ? SCL90_DATA : MMPI2_DATA,
  });
  if (!sheets.length) {
    setNote('这几项都要先求解；只想拿空白模板的话只勾选它。');
    return;
  }
  const out = serialize(sheets, dom.exportFormat.value, {
    basename: isScl90() ? 'scl90' : 'mmpi2',
  });
  if (out.binary) downloadBytes(out.filename, out.body, out.mime);
  else download(out.filename, out.body, out.mime);
  setNote(`已导出 ${out.filename}（${sheets.length} 张表）`);
}

/** Score answers pasted in from a real protocol, without solving anything. */
function runImport() {
  if (isScl90()) {
    const parsed = scl90ParseAnswers(dom.importText.value);
    if (parsed.found === 0) {
      setNote('没读到答案：支持 90 位 1–5 得分串，或每行「题号,得分」。');
      return;
    }
    const answers = parsed.answers.map((a) => (a === null ? 0 : a));
    const scores = scl90Score(answers);
    const itemBounds = scl90FeasibleBounds({});
    const plan = {
      scale: 'scl90',
      answers,
      scores,
      profile: scores,
      itemBounds,
      freedom: new Array(SCL90_DATA.nItems + 1).fill(true),
      freeItems: [...Array(SCL90_DATA.nItems).keys()].map((i) => i + 1),
      slack: new Array(SCL90_DATA.nItems + 1).fill(false),
      slackItems: [],
      lockedItems: [],
      lockReason: new Map(),
      target: {},
      requested: {},
      residual: {},
      bounds: {},
      isMale: true,
      feasible: true,
      hasRange: false,
      achieved: {},
      loss: 0,
      rawByName: {},
    };
    state.plan = plan;
    state.answers = answers;
    state.freedom = plan.freedom;
    state.slack = plan.slack;
    dom.results.hidden = false;
    renderScl90TargetTable(plan);
    renderScl90Profile(plan);
    renderAnswers(plan);
    renderItemBank();
    const notes = [`已读入 ${parsed.found} / ${SCL90_DATA.nItems} 题`];
    if (parsed.unknown.length) notes.push(`${parsed.unknown.length} 题缺失，按「没有」计。`);
    dom.importNote.textContent = notes.join('；');
    setNote(notes.join('；'));
    return;
  }
  const parsed = parseAnswers(dom.importText.value);
  if (parsed.found === 0) {
    setNote('没读到答案：支持 567 字符的 T/F 串，或每行一个 T/F、True/False、是/否。');
    return;
  }
  const filled = parsed.unknown.length ? fillUnknown(parsed.answers, { seed: state.seed }) : parsed.answers;
  const scored = scoreAnswers(filled, {
    isMale: state.isMale,
    correctInconsistency: state.correctInconsistency,
  });
  state.imported = { answers: filled, profile: scored.byName, rawByName: scored.rawByName, parsed };
  state.answers = filled;

  const notes = [`已读入 ${parsed.found} / ${MMPI2_DATA.nItems} 题`];
  if (parsed.unknown.length) {
    notes.push(`${parsed.unknown.length} 题未作答（已随机填充：题号 ${parsed.unknown.slice(0, 12).join('、')}${parsed.unknown.length > 12 ? '…' : ''}）`);
  }
  if (parsed.errors.length) notes.push(`${parsed.errors.length} 行无法识别`);
  dom.importNote.textContent = notes.join('；');

  dom.results.hidden = false;
  renderProfile(scored.byName);
  setNote(notes.join('；'));
}

function importFromFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    dom.importText.value = String(reader.result || '');
    runImport();
  };
  reader.readAsText(file, 'utf-8');
}

function invalidate(message) {
  state.plan = null;
  state.answers = null;
  state.slack = null;
  dom.results.hidden = true;
  dom.status.textContent = message;
  dom.status.className = 'status';
  renderItemBank();
  refreshSolveButton();
}

function wire() {
  if (dom.scaleSwitch) {
    dom.scaleSwitch.addEventListener('change', () => {
      switchScale(dom.scaleSwitch.value);
    });
  }
  dom.gender.addEventListener('change', () => {
    state.isMale = dom.gender.value === 'male';
    state.targets = retarget(state.targets);
    buildScaleList();
    invalidate('性别已切换，T 表不同，请重新生成答卷。');
  });

  dom.vrinMode.addEventListener('change', () => {
    state.correctInconsistency = dom.vrinMode.value === 'fixed';
    state.targets = retarget(state.targets);
    buildScaleList();
    invalidate('VRIN / TRIN 公式已切换，请重新生成答卷。');
  });

  dom.strength.addEventListener('change', () => {
    state.iterations = ITERATION_PRESETS[dom.strength.value];
  });

  dom.search.addEventListener('input', applySearch);
  if (dom.targetMode) {
    dom.targetMode.addEventListener('change', () => {
      state.mode = dom.targetMode.value;
      state.targets = convertTargets(
        state.targets,
        state.mode,
        optionsFor(state.isMale, state.correctInconsistency)
      );
      buildScaleList();
      invalidate('预期值模式已切换，请重新生成答卷。');
    });
  }
  // 主题切换：label 跟着当前 data-theme 走；选择写回 localStorage
  const syncThemeLabel = () => {
    if (!dom.themeToggle) return;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    dom.themeToggle.textContent = dark ? '☀ 浅色' : '🌙 深色';
  };
  if (dom.themeToggle) {
    syncThemeLabel();
    dom.themeToggle.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('mmpi-theme', next);
      } catch {
        /* localStorage 不可用时忽略，仅本次会话内切换 */
      }
      syncThemeLabel();
    });
  }
  dom.solve.addEventListener('click', () => runPlan());
  dom.again.addEventListener('click', () => runPlan({ newSeed: true }));
  dom.shuffle.addEventListener('click', () => {
    if (!state.plan) return;
    state.seed = (state.seed * 1103515245 + 12345) % 2147483647;
    // slack items only exist for range targets, and have to go one at a time
    state.answers = randomizeWithinBounds(state.answers, state.plan.bounds, {
      freeItems: state.plan.freeItems,
      slackItems: state.plan.slackItems,
      seed: state.seed,
      isMale: state.isMale,
      correctInconsistency: state.correctInconsistency,
    });
    refreshFreedom();
    renderAnswers(state.plan);
    renderItemBank();
    renderProfile(
      scoreAnswers(state.answers, {
        isMale: state.isMale,
        correctInconsistency: state.correctInconsistency,
      }).byName
    );
  });

  dom.copy.addEventListener('click', async () => {
    if (!state.answers) return;
    if (isScl90()) {
      const text = state.answers.map((l) => String(levelToScore(l))).join('');
      try {
        await navigator.clipboard.writeText(text);
        setNote(`已复制 ${text.length} 位得分串（1–5）到剪贴板。`);
      } catch {
        setNote('复制失败，请手动选择：' + text.slice(0, 80) + '…');
      }
      return;
    }
    const text = answersToCompact(state.answers);
    try {
      await navigator.clipboard.writeText(text);
      setNote(`已复制 ${text.length} 个字符的 T/F 串到剪贴板。`);
    } catch {
      setNote('复制失败，请手动选择：' + text.slice(0, 80) + '…');
    }
  });

  dom.csv.addEventListener('click', () => {
    if (!state.answers) return;
    if (isScl90()) {
      const lines = ['题号,得分,程度'];
      for (let i = 0; i < SCL90_DATA.nItems; i += 1) {
        const lvl = state.answers[i];
        const sc = levelToScore(lvl);
        const lab = SCL90_DATA.formats.likert5.levels[lvl]?.label || '';
        lines.push(`${i + 1},${sc},${lab}`);
      }
      download('scl90-answers.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
      return;
    }
    download('mmpi2-answers.csv', answersToCsv(state.answers, { isMale: state.isMale }), 'text/csv;charset=utf-8');
  });

  dom.example.addEventListener('click', () => {
    state.targets = {};
    applyTargets(EXAMPLE_TARGETS[state.isMale ? 'male' : 'female']);
    refreshSolveButton();
  });

  dom.clear.addEventListener('click', () => {
    state.targets = {};
    buildScaleList();
    invalidate('已清空目标。');
  });

  dom.bulkApply.addEventListener('click', () => {
    const { targets, unknown, unreachable } = parseBulkTargets(dom.bulk.value, { isMale: state.isMale });
    applyTargets(targets);
    refreshSolveButton();
    const notes = [];
    if (Object.keys(targets).length) notes.push(`已应用 ${Object.keys(targets).length} 个目标`);
    if (unknown.length) notes.push(`无法识别：${unknown.join('，')}`);
    if (unreachable.length) notes.push(`不在 T 表内（已折算）：${unreachable.join('，')}`);
    setNote(notes.join('；'));
  });

  dom.answers.addEventListener('click', onAnswerClick);
  // 多级作答滑杆：指针拖动 + 键盘
  dom.answers.addEventListener('pointerdown', onSliderDown);
  dom.answers.addEventListener('pointermove', onSliderMove);
  dom.answers.addEventListener('keydown', onSliderKey);
  window.addEventListener('pointerup', onSliderUp);
  window.addEventListener('pointercancel', onSliderUp);

  if (dom.exportRunPanel) {
    dom.exportRunPanel.addEventListener('click', runExport);
  }
  if (dom.importScore) {
    dom.importScore.addEventListener('click', runImport);
    dom.importFile.addEventListener('change', () => {
      const file = dom.importFile.files && dom.importFile.files[0];
      if (file) importFromFile(file);
    });
    dom.importTarget.addEventListener('click', () => {
      if (!state.imported) {
        setNote('先导入一份答卷再把它设为目标。');
        return;
      }
      const reachable = MMPI2_DATA.reachable[state.isMale ? 'male' : 'female'];
      const targets = {};
      for (const name of MMPI2_DATA.abbreviations[0]) {
        targets[name] = nearestReachable(reachable[name].values, state.imported.profile[name]);
      }
      applyTargets(targets);
      refreshSolveButton();
      setNote('已把导入剖面的 13 个基本量表设为求解目标（不在 T 表里的已就近折算）。');
    });
  }

  if (dom.showText) {
    dom.showText.addEventListener('change', () => {
      if (state.plan) renderAnswers(state.plan);
    });
  }
  if (dom.textLang) {
    dom.textLang.addEventListener('change', () => {
      if (state.plan) renderAnswers(state.plan);
    });
  }
  if (dom.bankSearch) {
    dom.bankSearch.addEventListener('input', renderItemBank);
    dom.bankFilter.addEventListener('change', renderItemBank);
  }
}

/* ------------------------------------------------------------------ *
 * SCL-90 量表（state.scale === 'scl90'）
 * ------------------------------------------------------------------ */

function buildScl90ScaleList() {
  const scales = scl90TargetScales();
  const html = scales
    .map((s) => {
      // 先放 3 个严重度预设，再列出该因子全部可达均分（步长 1/题数）
      const presetOpts = s.presets
        .map((p) => `<option value="${p.mean}">${p.label}（均分≈${p.mean}）</option>`)
        .join('');
      const allOpts = [];
      for (let k = s.n; k <= s.n * 5; k += 1) {
        const mean = k / s.n;
        allOpts.push(`<option value="${mean.toFixed(3)}">${mean.toFixed(2)}</option>`);
      }
      return (
        `<div class="row scl-row" data-name="${s.name}" data-search="${s.name.toLowerCase()}">` +
        `<span class="abbr" title="${s.fullName}">${s.name}</span>` +
        `<select data-name="${s.name}" data-edge="point">` +
        `<option value="">—</option>` +
        `<optgroup label="严重度预设">${presetOpts}</optgroup>` +
        `<optgroup label="全部可达均分">${allOpts.join('')}</optgroup>` +
        `</select>` +
        `<span class="full">${s.fullName}</span></div>`
      );
    })
    .join('');
  dom.scaleList.innerHTML = `<div class="rows">${html}</div>`;
  for (const select of dom.scaleList.querySelectorAll('select')) {
    const current = state.targets[select.dataset.name];
    select.value = current ? String(current.lo) : '';
    select.addEventListener('change', onTargetChanged);
  }
  applySearch();
}

function runScl90Plan(targets) {
  const means = {};
  for (const [name, spec] of Object.entries(targets)) means[name] = spec.lo;
  const r = scl90Solve(means);
  const scores = scl90Score(r.answers);
  const n = SCL90_DATA.nItems;
  const itemBounds = scl90FeasibleBounds(means);
  const freedom = new Array(n + 1).fill(true);
  const freeItems = [];
  const lockedItems = [];
  for (let i = 1; i <= n; i += 1) {
    const b = itemBounds[i];
    const isFree = b.lo < b.hi;
    freedom[i] = isFree;
    (isFree ? freeItems : lockedItems).push(i);
  }
  const bounds = {};
  for (const [name, m] of Object.entries(means)) bounds[name] = { lo: m, hi: m };
  const plan = {
    scale: 'scl90',
    answers: r.answers.slice(),
    achieved: r.achieved,
    target: { ...means },
    requested: { ...means },
    residual: {},
    loss: 0,
    feasible: true,
    hasRange: false,
    freedom,
    freeItems,
    itemBounds,
    slack: new Array(n + 1).fill(false),
    slackItems: [],
    lockedItems,
    lockReason: new Map(),
    profile: scores,
    rawByName: {},
    isMale: true,
    bounds,
    scores,
  };
  state.plan = plan;
  state.answers = r.answers.slice();
  state.freedom = freedom;
  state.slack = plan.slack;
  renderStatusScl90(plan);
  renderScl90TargetTable(plan);
  renderScl90Profile(plan);
  renderAnswers(plan);
  renderItemBank();
  dom.results.hidden = false;
  refreshSolveButton();
}

function renderStatusScl90(plan) {
  const n = Object.keys(plan.target).length;
  const lockN = plan.lockedItems ? plan.lockedItems.length : 0;
  const freeN = plan.freeItems ? plan.freeItems.length : SCL90_DATA.nItems;
  dom.status.textContent =
    `已生成答卷：命中 ${n} 个因子目标（精确求解，耗时 0 ms）；` +
    `锁定 ${lockN} 题、区间可调 ${freeN} 题。`;
  dom.status.className = 'status ok';
}

function renderScl90TargetTable(plan) {
  const rows = Object.keys(plan.target)
    .map((name) => {
      const t = plan.target[name];
      const f = plan.scores.factors[name];
      const got = f ? f.mean : name === '总分' ? plan.scores.total : plan.scores.totalMean;
      const band = plan.scores.diagnoses[name];
      const sev = band ? band.severity : '';
      const hot = band && band.severity !== '正常' ? 'hot' : '';
      return (
        `<tr class="ok"><td class="abbr">${name}</td>` +
        `<td>${Number(t).toFixed(1)}</td><td>${Number(got).toFixed(2)}</td>` +
        `<td class="${hot}">${sev}</td></tr>`
      );
    })
    .join('');
  dom.targetTable.innerHTML =
    `<thead><tr><th>因子</th><th>目标均分</th><th>达成均分</th><th>解释</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderScl90Profile(input) {
  const s = input.scores || input;
  const rows = SCL90_DATA.scales
    .map((f) => {
      const val = f.bind[0] === 0
        ? f.type === 'sum' ? s.total : s.totalMean.toFixed(2)
        : s.factors[f.name].mean.toFixed(2);
      const band = s.diagnoses[f.name];
      const sev = band ? band.severity : '';
      const hot = band && band.severity !== '正常' ? 'hot' : '';
      return `<tr class="${hot}"><td class="abbr">${f.name}</td><td>${val}</td><td>${sev}</td></tr>`;
    })
    .join('');
  const summary =
    `总分 ${s.total} · 总平均分 ${s.totalMean.toFixed(2)} · 阳性项目 ${s.positiveCount}/${SCL90_DATA.nItems}` +
    (s.positiveCount >= SCL90_DATA.positiveCutoff ? `（≥${SCL90_DATA.positiveCutoff}，可疑）` : '');
  dom.profile.innerHTML =
    `<p class="hint">${summary}</p>` +
    `<table><thead><tr><th>因子</th><th>均分/总分</th><th>解释</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function switchScale(value) {
  state.scale = value;
  state.targets = {};
  document.body.setAttribute('data-scale', value);
  const h1 = document.querySelector('header h1');
  const hp = document.querySelector('header p');
  const panel = dom.scaleList.closest('.panel');
  const leftH2 = panel ? panel.querySelector('h2') : null;
  const hTarget = document.getElementById('h-target');
  const hAnswers = document.getElementById('h-answers');
  const hBank = document.getElementById('h-bank');
  if (isScl90()) {
    if (h1) h1.textContent = 'SCL-90 自评量表';
    if (hp) hp.textContent = '选择各因子的目标严重度，反推出一份 90 题作答；或直接导入、编辑并评分。';
    if (leftH2) leftH2.textContent = '目标因子均分';
    if (hTarget) hTarget.textContent = '因子均分达成';
    if (hAnswers) hAnswers.textContent = '90 题回答';
    if (hBank) hBank.textContent = '题库（90 题原文）';
    if (dom.copy) dom.copy.textContent = '复制得分串';
    setNote('已切换到 SCL-90。选定因子严重度后点「生成答卷」。');
  } else {
    if (h1) h1.textContent = 'MMPI-2 反算器';
    if (hp) hp.textContent = '指定预期 T 分，反求出满足该剖面的 567 题答卷，并标出哪些题目的回答是被锁定的、哪些可以自由组合。';
    if (leftH2) leftH2.textContent = '目标 T 分';
    if (hTarget) hTarget.textContent = '目标达成';
    if (hAnswers) hAnswers.textContent = '567 题回答';
    if (hBank) hBank.textContent = '题库（567 题原文）';
    if (dom.copy) dom.copy.textContent = '复制 T/F';
  }
  buildScaleList();
  buildExportPanel();
  invalidate('已切换量表，请重新选择目标。');
}

export function init() {
  const ids = [
    'scale-switch', 'gender', 'vrin-mode', 'strength', 'note', 'search', 'scale-list', 'bulk', 'bulk-apply',
    'example', 'clear', 'solve', 'again', 'shuffle', 'copy', 'csv', 'status', 'results',
    'target-table', 'profile', 'answers', 'free-count', 'show-text',
    'export-contents', 'export-format', 'export-english', 'export-run-panel',
    'import-text', 'import-file', 'import-score', 'import-target', 'import-note',
    'text-lang', 'bank-search', 'bank-filter', 'bank-table', 'bank-count',
    'target-mode', 'theme-toggle',
  ];
  dom = {};
  for (const id of ids) {
    dom[camel(id)] = document.getElementById(id);
  }
  if (dom.targetMode) {
    dom.targetMode.innerHTML = TARGET_MODES
      .map((m) => `<option value="${m.id}">${m.label}</option>`)
      .join('');
    dom.targetMode.value = state.mode;
  }
  dom.note.hidden = true;
  dom.results.hidden = true;
  if (dom.scaleSwitch) {
    dom.scaleSwitch.innerHTML =
      '<option value="mmpi2">MMPI-2 明尼苏达多项人格测验</option>' +
      '<option value="scl90">SCL-90 症状自评量表</option>';
    dom.scaleSwitch.value = state.scale;
    document.body.setAttribute('data-scale', state.scale);
  }
  buildScaleList();
  buildExportPanel();
  renderItemBank();
  wire();
  refreshSolveButton();
  setupLongPressTips();
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
