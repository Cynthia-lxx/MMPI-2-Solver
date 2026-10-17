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
import { UI_TEXT } from './ui-tokens.js';
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
  scl90TargetScales,
} from './scl90.js';
import {
  likertScore,
  likertSolve,
  likertFeasibleBounds,
  likertSetItemLevel,
  likertTargetScales,
  likertParseAnswers,
  likertExportCsv,
  levelScore,
} from './likert.js';
import { PHQ9_DATA } from './phq9.data.js';
import { GAD7_DATA } from './gad7.data.js';
import { HADS_DATA } from './hads.data.js';
import { WHO5_DATA } from './who5.data.js';

// MBTI 数据/引擎按需异步加载：首屏不内联 1 万条 KNN 样本，切到 MBTI 时才拉取。
let MBTI_TYPES_16 = [];
let mbtiScore, mbtiSolve, mbtiScoreKnn, mbtiParseAnswers, mbtiExportCsv;
let mbtiLoadState = 'idle';
let mbtiReadyResolve;
export const mbtiReady = new Promise((r) => { mbtiReadyResolve = r; });

/** 通用异步加载进度界面：PC 把某版块变成进度条版块，手机叠加可取消/关闭的遮罩。
 *  返回 { set(frac, info), finish(), cancel() }，info = { pct, traffic }。 */
function showAsyncProgress(label, opts) {
  opts = opts || {};
  const bar = document.getElementById('loadbar');
  const fill = document.getElementById('loadbar-fill');
  const pctEl = document.getElementById('loadbar-pct');
  const panel = document.getElementById('load-panel');
  const pFill = document.getElementById('lp-fill');
  const pPct = document.getElementById('lp-pct');
  const pTraffic = document.getElementById('lp-traffic');
  const pLabel = document.getElementById('lp-label');
  const cancelBtn = document.getElementById('lp-cancel');
  const closeBtn = document.getElementById('lp-close');
  if (!panel || !pFill) return { set() {}, finish() {}, cancel() {} };
  const isMobile = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
  panel.classList.toggle('overlay', isMobile);
  panel.classList.toggle('inline', !isMobile);
  panel.hidden = false;
  if (pLabel) pLabel.textContent = label;
  pFill.style.width = '0%';
  if (pPct) pPct.textContent = '0.000%';
  if (pTraffic) pTraffic.textContent = '';
  if (bar) { bar.hidden = false; bar.classList.remove('done'); if (fill) fill.style.width = '0%'; }
  if (pctEl) { pctEl.hidden = false; pctEl.textContent = '0.000%'; }
  setNote(label);

  let userClosed = false;
  if (cancelBtn) cancelBtn.onclick = () => { if (opts.onCancel) opts.onCancel(); finish(); };
  if (closeBtn) closeBtn.onclick = () => { userClosed = true; panel.hidden = true; };

  const set = (frac, info) => {
    const p = Math.max(0, Math.min(1, frac || 0));
    const pct = p * 100;
    if (bar && fill) fill.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct.toFixed(3) + '%';
    if (!userClosed) {
      if (pFill) pFill.style.width = pct + '%';
      if (pPct) pPct.textContent = pct.toFixed(3) + '%';
      if (pTraffic && info && info.traffic) pTraffic.textContent = info.traffic;
    }
  };
  const finish = () => {
    if (bar && fill) fill.style.width = '100%';
    if (pctEl) pctEl.textContent = '100.000%';
    if (!userClosed) {
      if (pFill) pFill.style.width = '100%';
      if (pPct) pPct.textContent = '100.000%';
    }
    panel.classList.add('done');
    if (bar) bar.classList.add('done');
    setNote('');
    setTimeout(() => {
      panel.hidden = true;
      panel.classList.remove('overlay', 'inline', 'done');
      if (pFill) pFill.style.width = '0%';
      if (bar) { bar.hidden = true; bar.classList.remove('done'); if (fill) fill.style.width = '0%'; }
      if (pctEl) pctEl.hidden = true;
    }, 400);
  };
  const cancel = () => { if (opts.onCancel) opts.onCancel(); finish(); };
  return { set, finish, cancel };
}

async function loadMbtiTraffic(onProgress, signal) {
  const files = [
    'mbti_93.data.js', 'mbti_16p_quick.data.js', 'mbti_16p_standard.data.js',
    'mbti_16p_full.data.js', 'mbti_200md.data.js', 'mbti_16p60.data.js',
    'mbti.js', 'mbti_types.js',
  ];
  // 各分包真实字节数（构建期生成），用于按数据量统计进度；不可用则回退为按模块计数。
  let sizes = {};
  try { sizes = (await import('./mbti.sizes.js')).MBTI_SIZES || {}; } catch (e) { sizes = {}; }
  const loaded = {};
  let total = 0;
  for (const f of files) { loaded[f] = 0; total += sizes[f] || 0; }
  if (total === 0) total = files.length;
  const fmt = (n) => {
    if (n >= 1048576) return (n / 1048576).toFixed(2) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
    return n + ' B';
  };
  const report = () => {
    const cur = files.reduce((s, f) => s + loaded[f], 0);
    const frac = total ? cur / total : 0;
    onProgress(frac, { pct: (frac * 100).toFixed(3) + '%', traffic: `${fmt(cur)} / ${fmt(total)}` });
  };
  const out = {};
  await Promise.all(files.map(async (f) => {
    let mod;
    try {
      if (typeof fetch !== 'function') throw new Error('no fetch');
      const resp = await fetch('./' + f, signal ? { signal } : undefined);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const len = Number(resp.headers.get('content-length')) || sizes[f] || 0;
      const reader = resp.body && resp.body.getReader ? resp.body.getReader() : null;
      if (!reader) throw new Error('no stream');
      // 单次下载：边读字节边更新进度（真实流量），读完用 blob 导入执行，避免二次请求。
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); got += value.length; }
        loaded[f] = got;
        report();
      }
      const blob = new Blob(chunks, { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      try { mod = await import(url); } finally { URL.revokeObjectURL(url); }
      loaded[f] = len || got;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      // 回退：直接动态 import（file:// 或 fetch 不可用场景），按字节数加权计数。
      mod = await import('./' + f);
      loaded[f] = sizes[f] || 1;
    }
    Object.assign(out, mod);
    report();
  }));
  return out;
}

async function ensureMbti() {
  if (mbtiLoadState === 'ready') return;
  if (mbtiLoadState === 'loading') { await mbtiReady; return; }
  mbtiLoadState = 'loading';
  const controller = (typeof AbortController === 'function') ? new AbortController() : null;
  const progress = showAsyncProgress('正在加载 MBTI 题本数据…', {
    onCancel: controller ? () => controller.abort() : null,
  });
  let mod;
  let aborted = false;
  try {
    mod = await loadMbtiTraffic(progress.set, controller ? controller.signal : null);
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true;
    else {
      try { mod = await import('./mbti.async.js'); } catch { mod = null; }
      progress.set(1);
    }
  }
  if (aborted) {
    mbtiLoadState = 'idle';
    mbtiReadyResolve();
    progress.finish();
    setNote('已取消 MBTI 题本加载。');
    return;
  }
  if (!mod) {
    mbtiLoadState = 'idle';
    mbtiReadyResolve();
    progress.finish();
    setNote('MBTI 题本加载失败。');
    return;
  }
  MBTI_TYPES_16 = mod.MBTI_TYPES_16 || [];
  mbtiScore = mod.mbtiScore;
  mbtiSolve = mod.mbtiSolve;
  mbtiScoreKnn = mod.mbtiScoreKnn;
  mbtiParseAnswers = mod.mbtiParseAnswers;
  mbtiExportCsv = mod.mbtiExportCsv;
  SCALES.mbti93.data = mod.MBTI93_DATA;
  SCALES.mbti16p28.data = mod.MBTI16P_QUICK_DATA;
  SCALES.mbti16p93.data = mod.MBTI16P_STANDARD_DATA;
  SCALES.mbti16p200.data = mod.MBTI16P_FULL_DATA;
  SCALES.mbti200md.data = mod.MBTI200MD_DATA;
  SCALES.mbti16p60.data = mod.MBTI16P60_DATA;
  mbtiLoadState = 'ready';
  mbtiReadyResolve();
  progress.finish();
}

/** 量表注册表：加一个新量表 = 在这里加一行 + 一个数据模块 + 下拉里加一个 option。 */
const SCALES = {
  mmpi2: { id: 'mmpi2', short: 'MMPI-2', label: 'MMPI-2 明尼苏达多项人格测验', binary: true, data: MMPI2_DATA },
  scl90: { id: 'scl90', short: 'SCL-90', label: 'SCL-90 症状自评量表', binary: false, data: SCL90_DATA },
  phq9: { id: 'phq9', short: 'PHQ-9', label: 'PHQ-9 抑郁症筛查量表', binary: false, data: PHQ9_DATA },
  gad7: { id: 'gad7', short: 'GAD-7', label: 'GAD-7 焦虑筛查量表', binary: false, data: GAD7_DATA },
  hads: { id: 'hads', short: 'HADS', label: 'HADS 焦虑抑郁量表', binary: false, data: HADS_DATA },
  who5: { id: 'who5', short: 'WHO-5', label: 'WHO-5 主观幸福感量表', binary: false, data: WHO5_DATA },
  mbti93: { id: 'mbti93', short: 'MBTI-93', label: 'MBTI 职业性格测试（93 题）', typology: true, data: null },
  mbti16p28: { id: 'mbti16p_quick', short: 'MBTI-28', label: '16personalities 快速版（28 题）', typology: true, data: null },
  mbti16p93: { id: 'mbti16p_standard', short: '16P-93', label: '16personalities 标准版（93 题）', typology: true, data: null },
  mbti16p200: { id: 'mbti16p_full', short: '16P-200', label: '16personalities 完整版（200 题）', typology: true, data: null },
  mbti200md: { id: 'mbti200md', short: 'MBTI-200MD', label: 'MBTI 200 题（权威完整版）', typology: true, data: null },
  mbti16p60: { id: 'mbti16p60', short: '16P-60', label: '16personalities 60 题（KNN 数据集）', typology: true, data: null },
};

/** 当前量表的元数据。 */
function scaleMeta() {
  return SCALES[state.scale] || SCALES.mmpi2;
}

/** Keep the browser tab title in sync with the active scale (brand + scale short name). */
function updateDocTitle() {
  const meta = scaleMeta();
  const short = (meta && (meta.short || meta.label)) || 'MMPI-2';
  document.title = `PsychoInverse · 量表反算器 | ${short}`;
}

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

/** 当前激活量表的数据对象。 */
function currentData() {
  return scaleMeta().data;
}
const isBinary = () => scaleMeta().binary;
const isScl90 = () => state.scale === 'scl90';
const isTypology = () => !!scaleMeta().typology;

/** MBTI 八字母中文释义（用于维度标注与结果展示）。 */
const LETTER_CN = {
  E: '外向', I: '内向', S: '实感', N: '直觉', T: '思考', F: '情感', J: '判断', P: '知觉',
};

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
  if (isTypology()) return buildTypologyTarget();
  if (!isBinary()) return buildLikertScaleList();
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
  hydrateDropdowns(dom.scaleList);
  setupAnimatedDetails(dom.scaleList);
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
  if (!isBinary()) {
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
  const hasTargets = isTypology()
    ? currentData().scales.every((sc) => state.targets[sc.name])
    : Object.keys(state.targets).length > 0;
  dom.solve.disabled = !hasTargets;
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
  if (isTypology()) {
    runTypologyPlan();
    return;
  }
  const targets = collectTargets();
  if (!Object.keys(targets).length) {
    setNote(
      !isBinary()
        ? '请先在左侧为每个因子选择目标严重度（或直接导入作答）。'
        : '请先在左侧选择至少一个量表的目标 T 分。'
    );
    return;
  }
  if (!isBinary()) {
    runLikertPlan(targets);
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
  if (!isBinary()) return; // SCL-90 无锁定概念，全部自由
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
function commitLikertItem(item, startLevel) {
  if (!state.plan) return;
  const level = state.answers[item - 1];
  if (level === startLevel) return;
  state.answers = likertSetItemLevel(currentData(), state.answers, state.plan.target, item, level);
  state.plan.answers = state.answers;
  const scores = likertScore(currentData(), state.answers);
  state.plan.scores = scores;
  state.plan.profile = scores;
  renderLikertTargetTable(state.plan);
  renderLikertProfile(scores);
  renderAnswers(state.plan);
  renderItemBank();
}

/**
 * 指针按下：先只记录起点，不立即改值。
 * 触屏上允许纵向滑动页面（touch-action: pan-y），只有明显的横向拖动才接管。
 */
function onSliderDown(event) {
  const track = event.target.closest ? event.target.closest('.slide-track') : null;
  if (!track || !state.plan || !!isBinary()) return;
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
  commitLikertItem(drag.item, drag.start);
}

/** 键盘可访问：方向键 / Home / End 在可行区间内逐级调整。 */
function onSliderKey(event) {
  if (!!isBinary() || !state.plan) return;
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
  commitLikertItem(item, cur);
}

function renderAnswers(plan) {
  if (isTypology()) return renderTypologyAnswers(plan);
  const parts = [];
  const showText = dom.showText ? dom.showText.checked : false;
  const lang = dom.textLang ? dom.textLang.value : 'zh';
  for (let item = 1; item <= currentData().nItems; item += 1) {
    const free = state.freedom[item];
    const slacky = !free && !!state.slack && state.slack[item];
    const answer = state.answers[item - 1] ? 'T' : 'F';
    const text = itemText(item, currentData());
    let title;
    if (!isBinary()) {
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
      const b = !isBinary() && plan.itemBounds && plan.itemBounds[item]
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
  // 答案区动效：小题本逐格错峰浮现，大题本（如 MMPI 567）整体滑入以保性能
  if (currentData().nItems <= 120) {
    dom.answers.querySelectorAll('.cell').forEach((c, i) => {
      c.classList.add('cell-in');
      c.style.animationDelay = `${Math.min(i, 28) * 9}ms`;
    });
  } else {
    flashIn(dom.answers);
  }
  if (!isBinary()) {
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
  const total = currentData().nItems;
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
    const typ = isTypology();
    const text = typ
      ? {
          zh: (currentData().items.zh && currentData().items.zh[item - 1]) || '',
          en: (currentData().items.en && currentData().items.en[item - 1]) || '',
          topic: null,
        }
      : itemText(item, currentData());
    const optA = typ ? ((currentData().items.zhA && currentData().items.zhA[item - 1]) || '') : '';
    const optB = typ ? ((currentData().items.zhB && currentData().items.zhB[item - 1]) || '') : '';
    if (needle &&
        String(item) !== needle &&
        !(text.en || '').toLowerCase().includes(needle) &&
        !text.zh.toLowerCase().includes(needle) &&
        !(typ && (optA.toLowerCase().includes(needle) || optB.toLowerCase().includes(needle)))) continue;
    // MBTI：题干 + A/B 两个真实选项文本；选中项高亮。不再用维度字母当作选项/回答。
    if (typ) {
      const ans = state.answers ? state.answers[item - 1] : null;
      const [la, lb] = currentData().itemOptions[item - 1] || ['', ''];
      shown += 1;
      rows.push(
        `<tr data-item="${item}">` +
        `<td class="n">${item}</td>` +
        `<td class="zh">` +
          `<div class="bank-stem">${escapeHtml(text.zh)}</div>` +
          `<div class="bank-opt${ans === 0 ? ' on' : ''}">` +
            `<em style="background:var(--mbti-${String(la || 'e').toLowerCase()})">A</em>${escapeHtml(optA)}</div>` +
          `<div class="bank-opt${ans === 1 ? ' on' : ''}">` +
            `<em style="background:var(--mbti-${String(lb || 'e').toLowerCase()})">B</em>${escapeHtml(optB)}</div>` +
        `</td>` +
        `<td class="ans ${ans === null ? 'dim' : 'is-t'}">${ans === null ? '—' : ans ? 'B' : 'A'}</td>` +
        `<td class="st dim">—</td>` +
        `</tr>`
      );
      continue;
    }
    const answer = state.answers
      ? (isTypology()
          ? (state.answers[item - 1] ? currentData().itemOptions[item - 1][1] : currentData().itemOptions[item - 1][0])
          : (!isBinary() ? levelScore(currentData(), state.answers[item - 1]) : (state.answers[item - 1] ? 'T' : 'F')))
      : null;
    const bound = plan && !isBinary() && plan.itemBounds ? plan.itemBounds[item] : null;
    const free = plan
      ? (isTypology() ? null : (!isBinary() ? (bound ? bound.lo < bound.hi : true) : !!state.freedom[item]))
      : null;
    if (filter === 'free' && !free) continue;
    if (filter === 'locked' && free !== false) continue;
    if (filter === 't' && answer !== 'T') continue;
    if (filter === 'f' && answer !== 'F') continue;
    let statusText = '—';
    if (free !== null) {
      if (!isBinary()) {
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
      `<td class="ans ${answer === null ? 'dim' : answer === 'T' ? 'is-t' : !isBinary() ? 'is-lvl' : 'is-f'}">${answer || '—'}</td>` +
      `<td class="st ${free === null ? 'dim' : free ? 'free' : 'locked'}">${statusText}</td>` +
      '</tr>'
    );
  }
  const head = isTypology()
    ? '<thead><tr><th>题号</th><th>题目与选项</th><th>回答</th><th>状态</th></tr></thead>'
    : '<thead><tr><th>题号</th><th>英文原文</th><th>中文</th><th>回答</th><th>状态</th></tr></thead>';
  dom.bankTable.innerHTML = head + `<tbody>${rows.join('')}</tbody>`;
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
    if (!isBinary()) {
      renderAnswers(state.plan);
      renderLikertProfile(likertScore(currentData(), state.answers));
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
  if (isTypology()) {
    const item = Number(cell.dataset.item);
    const optEl = event.target.closest('[data-opt]');
    const next = optEl ? Number(optEl.dataset.opt) : (state.answers[item - 1] ? 0 : 1);
    if (optEl && state.answers[item - 1] === next) return;
    state.answers[item - 1] = next;
    const data = currentData();
    const scores = data.samples ? mbtiScoreKnn(data, state.answers) : mbtiScore(data, state.answers);
    state.plan.scores = scores;
    state.plan.profile = scores;
    state.plan.type = scores.type;
    state.plan.dims = scores.dims;
    state.plan.fromSample = false;
    renderTypologyProfile(state.plan);
    renderTypologyAnswers(state.plan);
    renderItemBank();
    return;
  }
  if (!isBinary()) return; // 多级量表只认级别按钮
  const isFree = cell.classList.contains('free');
  const isSlack = cell.classList.contains('slack');
  if (!isFree && !isSlack) return;
  state.answers[item - 1] = !state.answers[item - 1];
  const answer = state.answers[item - 1] ? 'T' : 'F';
  cell.querySelector('b').textContent = answer;
  cell.classList.toggle('is-t', state.answers[item - 1]);
  cell.classList.toggle('is-f', !state.answers[item - 1]);
  popCell(cell);
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
  if (isTypology()) {
    dom.exportContents.innerHTML =
      `<label class="check"><input type="checkbox" data-content="answers" checked>答题表（题号 / 所选字母 / 题面）</label>` +
      `<label class="check"><input type="checkbox" data-content="profile">类型与维度剖面</label>`;
    dom.exportFormat.innerHTML = '<option value="csv">CSV</option>';
    return;
  }
  const items = !isBinary()
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

/**
 * 导入区文案按当前量表自动生成：题数、选项数、作答类型都从 data / formats 取，
 * 新增量表（-3~3、1~7、1~100 等）无需再改这里。
 */
function applyScaleCopy() {
  if (!dom.importText) return;
  if (isTypology()) {
    const data = currentData();
    dom.importText.placeholder =
      `粘贴 ${data.nItems} 位作答串（A/B、0/1、T/F 均可）`;
    if (dom.importHint) {
      dom.importHint.textContent =
        '评分只算类型，不求解。未作答的题按 0（A）计；共 ' + data.nItems + ' 题。';
    }
    return;
  }
  const data = currentData();
  const desc = itemFormatDesc(data, 1);
  if (desc.type === 'binary') {
    dom.importText.placeholder =
      `粘贴 ${data.nItems} 个字符的 T/F 串，或每行一个答案（T / F、True / False、是 / 否），也可每行「题号,答案」`;
    if (dom.importHint) {
      dom.importHint.textContent =
        '评分只算剖面，不求解。未作答的题会随机填充（会告诉你填了哪些）。' +
        '「用作求解目标」把读入剖面的 13 个基本量表设为目标，便于反推等价答卷。';
    }
    return;
  }
  const m = desc.levels.length;
  dom.importText.placeholder =
    `粘贴 ${data.nItems} 位 ${m} 级得分串（1–${m}），或每行「题号,得分」（1–${m}）`;
  if (dom.importHint) {
    dom.importHint.textContent =
      `评分只算剖面，不求解。未作答的题按最低档（1）计；共 ${data.nItems} 题、每题 ${m} 档。`;
  }
}

function runExport() {
  if (isTypology()) {
    if (!state.answers) {
      setNote('请先生成或导入一份答卷。');
      return;
    }
    const csv = mbtiExportCsv(currentData(), state.answers);
    download(`${state.scale}-export.csv`, csv, 'text/csv;charset=utf-8');
    setNote(`已导出 ${state.scale}-export.csv。`);
    return;
  }
  if (!isBinary()) {
    if (!state.answers) {
      setNote(`请先生成或导入一份 ${scaleMeta().label} 答卷。`);
      return;
    }
    const data = currentData();
    const scores = likertScore(data, state.answers);
    const lines = ['题号,得分,程度'];
    for (let i = 0; i < data.nItems; i += 1) {
      const lvl = state.answers[i];
      const sc = levelScore(data, lvl);
      const lab = itemFormatDesc(data, i + 1).levels[lvl]?.label || '';
      lines.push(`${i + 1},${sc},${lab}`);
    }
    lines.push('', '因子,均分/总分,解释');
    for (const f of data.scales) {
      const metric = f.bandMetric || 'mean';
      const val = f.bind[0] === 0 && f.type === 'sum'
        ? scores.total
        : f.bind[0] === 0
          ? scores.totalMean.toFixed(2)
          : (metric === 'sum' ? scores.factors[f.name].raw : scores.factors[f.name].mean).toFixed(2);
      const sev = scores.diagnoses[f.name] ? scores.diagnoses[f.name].severity : '';
      lines.push(`${f.name},${val},${sev}`);
    }
    download(`${state.scale}-export.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
    setNote(`已导出 ${state.scale}-export.csv（${data.nItems} 题 + ${data.scales.length} 维度剖面）。`);
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
    data: currentData(),
  });
  if (!sheets.length) {
    setNote('这几项都要先求解；只想拿空白模板的话只勾选它。');
    return;
  }
  const out = serialize(sheets, dom.exportFormat.value, {
    basename: !isBinary() ? 'scl90' : 'mmpi2',
  });
  if (out.binary) downloadBytes(out.filename, out.body, out.mime);
  else download(out.filename, out.body, out.mime);
  setNote(`已导出 ${out.filename}（${sheets.length} 张表）`);
}

/** Score answers pasted in from a real protocol, without solving anything. */
function runImport() {
  if (isTypology()) {
    const data = currentData();
    const raw = dom.importText.value || '';
    const parsed = mbtiParseAnswers(data, raw);
    const found = String(raw).replace(/\s/g, '').split('').filter((c) => /[0-1ABab]/i.test(c)).length;
    if (found === 0) {
      setNote(`没读到答案：支持 ${data.nItems} 位作答串（A/B、0/1、T/F 均可）。`);
      return;
    }
    const answers = parsed;
    const scores = data.samples ? mbtiScoreKnn(data, answers) : mbtiScore(data, answers);
    const plan = makeTypologyPlan(data, answers, scores, false);
    state.plan = plan;
    state.answers = answers.slice();
    state.freedom = plan.freedom;
    state.slack = plan.slack;
    dom.results.hidden = false;
    renderTypologyProfile(plan);
    renderTypologyAnswers(plan);
    renderItemBank();
    dom.importNote.textContent = `已读入 ${found} / ${data.nItems} 题`;
    setNote(`已读入 ${found} / ${data.nItems} 题。`);
    return;
  }
  if (!isBinary()) {
    const data = currentData();
    const parsed = likertParseAnswers(data, dom.importText.value);
    if (parsed.found === 0) {
      setNote(`没读到答案：支持 ${data.nItems} 位得分串，或每行「题号,得分」。`);
      return;
    }
    const answers = parsed.answers.map((a) => (a === null ? 0 : a));
    const scores = likertScore(data, answers);
    const itemBounds = likertFeasibleBounds(data, {});
    const plan = {
      scale: state.scale,
      answers,
      scores,
      profile: scores,
      itemBounds,
      freedom: new Array(data.nItems + 1).fill(true),
      freeItems: [...Array(data.nItems).keys()].map((i) => i + 1),
      slack: new Array(data.nItems + 1).fill(false),
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
    renderLikertTargetTable(plan);
    renderLikertProfile(plan);
    renderAnswers(plan);
    renderItemBank();
    const notes = [`已读入 ${parsed.found} / ${data.nItems} 题`];
    if (parsed.unknown.length) notes.push(`${parsed.unknown.length} 题缺失，按最低档计。`);
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
    if (isTypology()) {
      const data = currentData();
      const text = state.answers.map((a, i) => data.itemOptions[i][a ? 1 : 0]).join('');
      try {
        await navigator.clipboard.writeText(text);
        setNote(`已复制 ${text.length} 位作答串（每题所选字母）到剪贴板。`);
      } catch {
        setNote('复制失败，请手动选择：' + text.slice(0, 80) + '…');
      }
      return;
    }
    if (!isBinary()) {
      const data = currentData();
      const text = state.answers.map((l) => String(levelScore(data, l))).join('');
      try {
        await navigator.clipboard.writeText(text);
        setNote(`已复制 ${text.length} 位得分串（${levelScore(data, 0)}–${levelScore(data, data.formats.likert.levels.length - 1)}）到剪贴板。`);
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
    if (isTypology()) {
      const csv = mbtiExportCsv(currentData(), state.answers);
      download(`${state.scale}-answers.csv`, csv, 'text/csv;charset=utf-8');
      return;
    }
    if (!isBinary()) {
      const data = currentData();
      const csv = likertExportCsv(data, state.answers);
      download(`${state.scale}-answers.csv`, csv, 'text/csv;charset=utf-8');
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

function buildLikertScaleList() {
  const data = currentData();
  // SCL-90 用其专属预设均值（漂亮的整数均值）；其余量表直接用通用引擎枚举
  const scales = state.scale === 'scl90' ? scl90TargetScales() : likertTargetScales(data);
  const html = scales
    .map((s) => {
      const unit = s.metric === 'sum' ? '总分' : '均分';
      const presetOpts = s.presets
        .map((p) => {
          const v = p.value !== undefined ? p.value : p.mean;
          return `<option value="${v}">${p.label}（${unit}≈${v}）</option>`;
        })
        .join('');
      const allOpts = s.allValues
        ? s.allValues.map((v) => `<option value="${v}">${v}</option>`).join('')
        : (() => {
            const out = [];
            for (let k = s.n; k <= s.n * 5; k += 1) {
              const mean = k / s.n;
              out.push(`<option value="${mean.toFixed(3)}">${mean.toFixed(2)}</option>`);
            }
            return out.join('');
          })();
      return (
        `<div class="row scl-row" data-name="${s.name}" data-search="${s.name.toLowerCase()}">` +
        `<span class="abbr" title="${s.fullName}">${s.name}</span>` +
        `<select data-name="${s.name}" data-edge="point">` +
        `<option value="">—</option>` +
        `<optgroup label="严重度预设">${presetOpts}</optgroup>` +
        `<optgroup label="全部可达均分">${allOpts}</optgroup>` +
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
  hydrateDropdowns(dom.scaleList);
  setupAnimatedDetails(dom.scaleList);
  applySearch();
}

function runLikertPlan(targets) {
  const data = currentData();
  const means = {};
  for (const [name, spec] of Object.entries(targets)) means[name] = spec.lo;
  const r = likertSolve(data, means);
  const scores = likertScore(data, r.answers);
  const n = data.nItems;
  const itemBounds = likertFeasibleBounds(data, means);
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
    scale: state.scale,
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
  renderLikertStatus(plan);
  renderLikertTargetTable(plan);
  renderLikertProfile(plan);
  renderAnswers(plan);
  renderItemBank();
  dom.results.hidden = false;
  refreshSolveButton();
}

function renderLikertStatus(plan) {
  const n = Object.keys(plan.target).length;
  const lockN = plan.lockedItems ? plan.lockedItems.length : 0;
  const freeN = plan.freeItems ? plan.freeItems.length : currentData().nItems;
  dom.status.textContent =
    `已生成答卷：命中 ${n} 个目标（精确求解，耗时 0 ms）；` +
    `锁定 ${lockN} 题、区间可调 ${freeN} 题。`;
  dom.status.className = 'status ok';
}

function renderLikertTargetTable(plan) {
  const data = currentData();
  const rows = Object.keys(plan.target)
    .map((name) => {
      const t = plan.target[name];
      const f = plan.scores.factors[name];
      const metric = data.scales.find((s) => s.name === name);
      const got = f
        ? (metric && metric.bandMetric === 'sum' ? f.raw : f.mean)
        : name === '总分' && metric && metric.bandMetric === 'sum'
          ? plan.scores.total
          : plan.scores.totalMean;
      const band = plan.scores.diagnoses[name];
      const sev = band ? band.severity : '';
      const hot = band && band.severity !== '正常' ? 'hot' : '';
      return (
        `<tr class="ok"><td class="abbr">${name}</td>` +
        `<td>${Number(t).toFixed(2)}</td><td>${Number(got).toFixed(2)}</td>` +
        `<td class="${hot}">${sev}</td></tr>`
      );
    })
    .join('');
  const unit = '达成';
  dom.targetTable.innerHTML =
    `<thead><tr><th>因子</th><th>目标</th><th>达成</th><th>解释</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderLikertProfile(input) {
  const data = currentData();
  const s = input.scores || input;
  const rows = data.scales
    .map((f) => {
      const metric = f.bandMetric || 'mean';
      const val =
        f.bind[0] === 0 && f.type === 'sum'
          ? s.total
          : f.bind[0] === 0
            ? s.totalMean.toFixed(2)
            : (metric === 'sum' ? s.factors[f.name].raw : s.factors[f.name].mean).toFixed(2);
      const band = s.diagnoses[f.name];
      const sev = band ? band.severity : '';
      const hot = band && band.severity !== '正常' ? 'hot' : '';
      return `<tr class="${hot}"><td class="abbr">${f.name}</td><td>${val}</td><td>${sev}</td></tr>`;
    })
    .join('');
  const parts = [`总分 ${s.total}`, `总均分 ${s.totalMean.toFixed(2)}`];
  if (data.positiveScore) {
    parts.push(`阳性项目 ${s.positiveCount}/${data.nItems}` +
      (s.positiveCount >= data.positiveCutoff ? `（≥${data.positiveCutoff}，可疑）` : ''));
  }
  if (data.note) parts.push(data.note);
  dom.profile.innerHTML =
    `<p class="hint">${parts.join(' · ')}</p>` +
    `<table><thead><tr><th>因子</th><th>均分/总分</th><th>解释</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** 重启一个 CSS 动画（移除类→强制重排→加回），让区块切换/重建时有滑入反馈 */
function flashIn(el, cls = 'content-in') {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth; // 强制重排以重启动画
  el.classList.add(cls);
}

/** 答案格被点击翻转时的弹跳反馈 */
function popCell(cell) {
  if (!cell) return;
  cell.classList.remove('cell-pop');
  void cell.offsetWidth;
  cell.classList.add('cell-pop');
}

/* ============ 自研下拉菜单 ============
 * 原生 <select> 保留在 DOM 中（可访问性 + 测试契约：querySelectorAll('select') /
 * .options / .value / change 全部照常可用），其上叠加带「展开 / 收起 / 选择」
 * 动效的自定义触发器与弹出层。选择时改写原生 select.value 并派发 change 事件，
 * 既有监听逻辑（onTargetChanged 等）零改动；标签同步由原生 change 与显式
 * syncAllDropdowns 双重保证。 */
function getCurrentOptionText(select) {
  const sel = [...select.options].find((o) => o.value === select.value);
  return (sel || [...select.options].find((o) => o.selected) || select.options[0])?.textContent || '';
}

let _closeAllDropdowns = null;
const _raf = (cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 0));

let _sheet = null;
let _sheetCloseTimer = null;
const isCompact = () =>
  (typeof window !== 'undefined' && typeof window.matchMedia === 'function') &&
  window.matchMedia('(max-width: 640px), (pointer: coarse)').matches;

function ensureSheet() {
  if (_sheet) return _sheet;
  const scrim = document.createElement('div');
  scrim.className = 'dd-sheet-scrim';
  scrim.hidden = true;
  const sheet = document.createElement('div');
  sheet.className = 'dd-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  const head = document.createElement('div');
  head.className = 'dd-sheet-head';
  const title = document.createElement('div');
  title.className = 'dd-sheet-title';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'dd-sheet-close';
  closeBtn.setAttribute('aria-label', '关闭');
  closeBtn.textContent = '✕';
  head.append(title, closeBtn);
  const listEl = document.createElement('ul');
  listEl.className = 'dd-sheet-list';
  listEl.setAttribute('role', 'listbox');
  listEl.tabIndex = -1;
  sheet.append(head, listEl);
  scrim.append(sheet);
  document.body.append(scrim);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSheet(); });
  closeBtn.addEventListener('click', () => closeSheet());
  _sheet = { scrim, sheet, head, title, listEl, closeBtn };
  return _sheet;
}

function closeSheet() {
  if (!_sheet || !_sheet.scrim.classList.contains('open')) return;
  _sheet.scrim.classList.remove('open');
  document.body.classList.remove('dd-sheet-open');
  clearTimeout(_sheetCloseTimer);
  _sheetCloseTimer = setTimeout(() => {
    if (!_sheet.scrim.classList.contains('open')) _sheet.scrim.hidden = true;
  }, 320);
  if (_sheet.scrim._owner && typeof _sheet.scrim._owner.setClosed === 'function') _sheet.scrim._owner.setClosed();
}

function setupAnimatedDetails(root = document) {
  (root || document).querySelectorAll('details').forEach((d) => {
    if (d._animated) return;
    d._animated = true;
    const summary = d.querySelector(':scope > summary');
    if (!summary) return;
    const body = document.createElement('div');
    body.className = 'details-body';
    const inner = document.createElement('div');
    inner.className = 'details-inner';
    [...d.children].forEach((ch) => { if (ch !== summary) inner.appendChild(ch); });
    body.appendChild(inner);
    d.appendChild(body);
    // 仅在动画期间裁剪，展开完成后恢复可见，避免误伤内部下拉面板
    d.addEventListener('toggle', () => {
      d.classList.add('animating');
      clearTimeout(d._t);
      d._t = setTimeout(() => d.classList.remove('animating'), 360);
    });
  });
}

function hydrateDropdown(select) {
  if (!select || select._dropdown || !select.options) return;
  select._dropdown = true;
  select.classList.add('select-native');

  const wrap = document.createElement('span');
  wrap.className = 'dropdown';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dropdown-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'dropdown-label';
  const caret = document.createElement('span');
  caret.className = 'dropdown-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';
  trigger.append(label, caret);

  const panel = document.createElement('div');
  panel.className = 'dropdown-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  const list = document.createElement('ul');
  list.className = 'dropdown-list';
  panel.appendChild(list);

  // 把原生 select 移入 wrapper（仍能被 querySelectorAll('select') 命中）
  select.parentNode.insertBefore(wrap, select);
  wrap.append(select, trigger, panel);

  const sync = () => { label.textContent = getCurrentOptionText(select); };
  sync();
  select._syncDropdown = sync;

  const closeInline = () => {
    if (!wrap.classList.contains('open')) return;
    wrap.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    setTimeout(() => { if (!wrap.classList.contains('open')) panel.hidden = true; }, 320);
  };
  const setActive = (items, idx) => {
    if (!items.length) return;
    activeIdx = (idx + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
    const el = items[activeIdx];
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  };
  const selectOption = (li) => {
    const o = [...select.options].find((opt) => opt.value === li.dataset.value);
    if (!o) return;
    if (o.value === select.value) { closeCurrent(); return; }
    select.value = o.value;
    sync();
    const parent = li.parentElement;
    if (parent) parent.querySelectorAll('.dropdown-option.selected').forEach((x) => x.classList.remove('selected'));
    li.classList.add('selected');
    li.classList.remove('picked'); void li.offsetWidth; li.classList.add('picked');
    trigger.classList.remove('pulse'); void trigger.offsetWidth; trigger.classList.add('pulse');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    closeCurrent();
  };
  let activeIdx = -1;
  let surface = null; // 'inline' | 'sheet'
  const buildOptions = (targetUl) => {
    targetUl.innerHTML = '';
    [...select.options].forEach((o, i) => {
      const li = document.createElement('li');
      li.className = 'dropdown-option';
      li.setAttribute('role', 'option');
      li.dataset.value = o.value;
      li.textContent = o.textContent;
      if (o.value === select.value) { li.classList.add('selected'); activeIdx = i; }
      li.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); selectOption(li); });
      targetUl.appendChild(li);
    });
  };
  const openInline = () => {
    surface = 'inline';
    if (list.children.length !== select.options.length) buildOptions(list);
    else list.querySelectorAll('.dropdown-option').forEach((li) => {
      const on = li.dataset.value === select.value;
      li.classList.toggle('selected', on);
      if (on) activeIdx = [...list.children].indexOf(li);
    });
    panel.hidden = false;
    _raf(() => wrap.classList.add('open'));
    trigger.setAttribute('aria-expanded', 'true');
    setActive([...list.children], activeIdx < 0 ? 0 : activeIdx);
    trigger.focus();
  };
  const closeBtnFocus = () => { if (_sheet) _sheet.closeBtn.focus(); };
  const openSheet = () => {
    surface = 'sheet';
    const s = ensureSheet();
    s.title.textContent = label.textContent || select.getAttribute('aria-label') || '请选择';
    buildOptions(s.listEl);
    const sel = s.listEl.querySelector('.dropdown-option.selected');
    if (sel && typeof sel.scrollIntoView === 'function') sel.scrollIntoView({ block: 'center' });
    s.scrim.hidden = false;
    document.body.classList.add('dd-sheet-open');
    _raf(() => s.scrim.classList.add('open'));
    trigger.setAttribute('aria-expanded', 'true');
    s.scrim._owner = { setClosed: () => { trigger.setAttribute('aria-expanded', 'false'); surface = null; } };
    s.listEl.focus();
    s.listEl.onkeydown = (e) => {
      const items = [...s.listEl.children];
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(items, activeIdx + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(items, activeIdx - 1); }
      else if (e.key === 'Home') { e.preventDefault(); setActive(items, 0); }
      else if (e.key === 'End') { e.preventDefault(); setActive(items, items.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (items[activeIdx]) selectOption(items[activeIdx]); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSheet(); closeBtnFocus(); }
    };
  };
  const closeCurrent = () => {
    if (surface === 'sheet') closeSheet();
    else closeInline();
    trigger.setAttribute('aria-expanded', 'false');
    surface = null;
  };

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (surface) { closeCurrent(); return; }
    if (_closeAllDropdowns) _closeAllDropdowns(); // 先收起其它已展开的下拉 / 叠加面板
    if (isCompact()) openSheet(); else openInline();
  });
  trigger.addEventListener('keydown', (e) => {
    if (surface) return; // 展开后由对应 surface 自行处理键盘
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (isCompact()) openSheet(); else openInline();
    }
  });
  // 用户经其它途径改 select.value 时（如测试 / 代码）保持标签同步
  select.addEventListener('change', sync);

  select._closeDropdown = closeCurrent;
  if (!_closeAllDropdowns) {
    _closeAllDropdowns = () => {
      document.querySelectorAll('.dropdown.open').forEach((d) => {
        d.classList.remove('open');
        const t = d.querySelector('.dropdown-trigger'); if (t) t.setAttribute('aria-expanded', 'false');
        const p = d.querySelector('.dropdown-panel'); if (p) setTimeout(() => { if (!d.classList.contains('open')) p.hidden = true; }, 320);
      });
      closeSheet(); // 同时收起移动端叠加面板
    };
    document.addEventListener('click', (e) => { if (!e.target.closest('.dropdown') && !e.target.closest('.dd-sheet-scrim')) _closeAllDropdowns(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeAllDropdowns(); });
  }
}

function hydrateDropdowns(root = document) {
  (root || document).querySelectorAll('select').forEach(hydrateDropdown);
}
function syncAllDropdowns(root = document) {
  (root || document).querySelectorAll('select').forEach((s) => s._syncDropdown && s._syncDropdown());
}

async function switchScale(value) {
  state.scale = value;
  state.targets = {};
  document.body.setAttribute('data-scale', value);
  updateDocTitle();
  const meta = SCALES[value];
  if (meta && meta.typology && !meta.data) {
    setNote('正在加载 MBTI 题本数据…');
    await ensureMbti();
  }
  const targetTable = dom.targetTable;
  if (targetTable) targetTable.hidden = isTypology();
  const hTargetEl = document.getElementById('h-target');
  if (hTargetEl) hTargetEl.hidden = isTypology();
  const h1 = document.querySelector('header h1');
  const hp = document.querySelector('header p');
  const panel = dom.scaleList.closest('.panel');
  const leftH2 = panel ? panel.querySelector('h2') : null;
  const hTarget = document.getElementById('h-target');
  const hAnswersLabel = document.getElementById('h-answers-label');
  const hBank = document.getElementById('h-bank');
  const summaryProfile = document.getElementById('summary-profile');
  if (isBinary()) {
    if (h1) h1.textContent = 'MMPI-2 反算器';
    if (hp) hp.textContent = '指定预期 T 分，反求出满足该剖面的 567 题答卷，并标出哪些题目的回答是被锁定的、哪些可以自由组合。';
    if (leftH2) leftH2.textContent = '目标 T 分';
    if (hTarget) hTarget.textContent = '目标达成';
    if (hAnswersLabel) hAnswersLabel.textContent = '567 题回答';
    if (hBank) hBank.textContent = '题库（567 题原文）';
    if (summaryProfile) summaryProfile.textContent = UI_TEXT.profileSummaryMmpi;
    if (dom.copy) dom.copy.textContent = '复制 T/F';
  } else if (isTypology()) {
    const meta = scaleMeta();
    if (h1) h1.textContent = meta.label;
    if (hp) hp.textContent = meta.data.blurb || '选择目标人格类型，反推出一份能命中该类型的作答；或直接导入、编辑并评分。';
    if (leftH2) leftH2.textContent = '目标人格类型';
    if (hTarget) hTarget.textContent = '类型达成';
    if (hAnswersLabel) hAnswersLabel.textContent = `${meta.data.nItems} 题回答`;
    if (hBank) hBank.textContent = `题库（${meta.data.nItems} 题）`;
    if (summaryProfile) summaryProfile.textContent = '类型与维度倾向';
    if (dom.copy) dom.copy.textContent = '复制作答串';
    setNote(`已切换到 ${meta.label}。选择目标类型后点「生成答卷」。`);
  } else if (state.scale === 'scl90') {
    if (h1) h1.textContent = 'SCL-90 自评量表';
    if (hp) hp.textContent = '选择各因子的目标严重度，反推出一份 90 题作答；或直接导入、编辑并评分。';
    if (leftH2) leftH2.textContent = '目标因子均分';
    if (hTarget) hTarget.textContent = '因子均分达成';
    if (hAnswersLabel) hAnswersLabel.textContent = '90 题回答';
    if (hBank) hBank.textContent = '题库（90 题原文）';
    if (summaryProfile) summaryProfile.textContent = '完整剖面（9 临床因子 + 其他 + 总分）';
    if (dom.copy) dom.copy.textContent = '复制得分串';
    setNote('已切换到 SCL-90。选定因子严重度后点「生成答卷」。');
  } else {
    // 其它 likert 量表（PHQ-9 / GAD-7 / HADS / WHO-5 …）按数据驱动生成
    const meta = scaleMeta();
    if (h1) h1.textContent = meta.label;
    if (hp) hp.textContent = meta.data.blurb || '';
    if (leftH2) leftH2.textContent = meta.data.targetLabel || '目标得分';
    if (hTarget) hTarget.textContent = meta.data.targetTableTitle || '得分达成';
    if (hAnswersLabel) hAnswersLabel.textContent = `${meta.data.nItems} 题回答`;
    if (hBank) hBank.textContent = `题库（${meta.data.nItems} 题原文）`;
    if (summaryProfile) summaryProfile.textContent = `完整剖面（${meta.data.scales.length} 个维度）`;
    if (dom.copy) dom.copy.textContent = '复制得分串';
    setNote(`已切换到 ${meta.label}。选定目标后点「生成答卷」。`);
  }
  buildScaleList();
  buildExportPanel();
  applyScaleCopy();
  invalidate('已切换量表，请重新选择目标。');
  // 切换量表：内容区块轻微滑入
  flashIn(dom.scaleList);
  flashIn(dom.answers);
  flashIn(dom.profile);
  flashIn(dom.bankTable ? dom.bankTable.closest('.bank-wrap') : null);
}

export function init() {
  const ids = [
    'scale-switch', 'gender', 'vrin-mode', 'strength', 'note', 'search', 'scale-list', 'bulk', 'bulk-apply',
    'example', 'clear', 'solve', 'again', 'shuffle', 'copy', 'csv', 'status', 'results',
    'target-table', 'profile', 'answers', 'free-count', 'show-text',
    'export-contents', 'export-format', 'export-english', 'export-run-panel',
    'import-text', 'import-file', 'import-score', 'import-target', 'import-note', 'import-hint',
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
    dom.scaleSwitch.innerHTML = Object.entries(SCALES)
      .map(([k, s]) => `<option value="${k}">${s.label}</option>`)
      .join('');
    dom.scaleSwitch.value = state.scale;
    document.body.setAttribute('data-scale', state.scale);
  }
  updateDocTitle();
  buildScaleList();
  buildExportPanel();
  applyScaleCopy();
  renderItemBank();
  wire();
  refreshSolveButton();
  setupLongPressTips();
  hydrateDropdowns(document); // 把工具栏 / 量表切换等原生 select 升级为自研下拉
  setupAnimatedDetails(document);
  setupCollapsibleToolbar();
}

function setupCollapsibleToolbar() {
  const toolbar = document.getElementById('toolbar');
  const toggle = document.getElementById('toolbar-toggle');
  const summary = document.getElementById('toolbar-summary');
  if (!toolbar || !toggle) return;
  const KEY = 'mmpi2.toolbarCollapsed';
  const isMobile = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches;
  let collapsed;
  try {
    const saved = localStorage.getItem(KEY);
    collapsed = saved === null ? isMobile() : saved === '1';
  } catch (e) { collapsed = isMobile(); }
  const apply = (val) => {
    collapsed = val;
    toolbar.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  apply(collapsed);
  toggle.addEventListener('click', (e) => {
    e.preventDefault();
    apply(!collapsed);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch (e2) { /* 隐私模式忽略 */ }
  });
  // 收起时在标题栏显示当前量表名，避免展开才知道上下文
  const sel = document.getElementById('scale-switch');
  const updateSummary = () => {
    if (!summary || !sel || !sel.options.length) return;
    const opt = sel.options[sel.selectedIndex];
    summary.textContent = opt ? opt.textContent : '';
  };
  updateSummary();
  if (sel) sel.addEventListener('change', updateSummary);
  // 量表选项可能在异步初始化后填充，稍后再刷新一次摘要
  setTimeout(updateSummary, 400);
}

function camel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/* -- MBTI typology（第四种范式：选定人格类型 → 反推作答） ---------------- */

function makeTypologyPlan(data, answers, scores, fromSample) {
  const n = data.nItems;
  return {
    scale: state.scale,
    answers: answers.slice(),
    target: { __type: scores.type },
    requested: { __type: scores.type },
    residual: {},
    feasible: true,
    fromSample: !!fromSample,
    type: scores.type,
    dims: scores.dims,
    scores,
    profile: scores,
    freedom: new Array(n + 1).fill(true),
    freeItems: [...Array(n).keys()].map((i) => i + 1),
    itemBounds: null,
    slack: new Array(n + 1).fill(false),
    slackItems: [],
    lockedItems: [],
    lockReason: new Map(),
    rawByName: {},
  };
}

function buildTypologyTarget() {
  const data = currentData();
  const types = MBTI_TYPES_16 || [];
  const typeOpts = types
    .map((t) => `<option value="${t.id}">${t.id} · ${escapeHtml(t.name || '')}（${escapeHtml(t.category || '')}）</option>`)
    .join('');
  const dimPickers = data.scales
    .map((sc) => {
      const [a, b] = sc.pair;
      const opts = [
        `<option value="">—</option>`,
        `<option value="${a}">${a} ${LETTER_CN[a] || ''}</option>`,
        `<option value="${b}">${b} ${LETTER_CN[b] || ''}</option>`,
      ];
      if (sc.tieThreshold > 0) opts.push(`<option value="X">X 中间型</option>`);
      return (
        `<div class="row typ-row" data-dim="${sc.name}">` +
        `<span class="abbr" title="${sc.name}">${sc.name}</span>` +
        `<select data-dim="${sc.name}">${opts.join('')}</select>` +
        `<span class="full">${LETTER_CN[a] || a} ↔ ${LETTER_CN[b] || b}</span></div>`
      );
    })
    .join('');
  dom.scaleList.innerHTML =
    `<div class="rows typ-targets">` +
    `<div class="typ-quick"><label>快捷类型</label><select id="typ-type">` +
    `<option value="">— 选择 16 型 —</option>${typeOpts}</select></div>` +
    dimPickers +
    `</div>`;
  const sel = dom.scaleList.querySelector('#typ-type');
  if (sel) sel.addEventListener('change', onTypTypePicked);
  for (const s of dom.scaleList.querySelectorAll('select[data-dim]')) {
    s.value = state.targets[s.dataset.dim] || '';
    s.addEventListener('change', onTypDimChanged);
  }
  hydrateDropdowns(dom.scaleList);
  setupAnimatedDetails(dom.scaleList);
  applySearch();
}

function onTypTypePicked(event) {
  const v = event.target.value;
  if (!v) return;
  const data = currentData();
  data.scales.forEach((sc, i) => {
    const ch = v[i];
    const sel = dom.scaleList.querySelector(`select[data-dim="${sc.name}"]`);
    if (sel) sel.value = ch;
    state.targets[sc.name] = ch;
  });
  refreshSolveButton();
}

function onTypDimChanged(event) {
  const dim = event.target.dataset.dim;
  const v = event.target.value;
  if (!v) delete state.targets[dim];
  else state.targets[dim] = v;
  const data = currentData();
  const type = data.scales.map((sc) => state.targets[sc.name] || '').join('');
  const quick = dom.scaleList.querySelector('#typ-type');
  if (quick) quick.value = type.length === 4 && !type.includes('') ? type : '';
  syncAllDropdowns(dom.scaleList); // 维度下拉被程序回填，刷新各自标签
  refreshSolveButton();
}

function runTypologyPlan() {
  const data = currentData();
  const type = data.scales.map((sc) => state.targets[sc.name] || '').join('');
  if (type.length < 4) {
    setNote('请为四个维度各选择一个字母（或选快捷类型）。');
    return;
  }
  dom.status.textContent = '生成中…';
  dom.status.className = 'status busy';
  setTimeout(() => {
    const started = Date.now();
    const r = mbtiSolve(data, type, { rng: Math.random });
    const answers = r.answers;
    const scores = data.samples ? mbtiScoreKnn(data, answers) : mbtiScore(data, answers);
    const plan = makeTypologyPlan(data, answers, scores, r.fromSample);
    state.plan = plan;
    state.answers = answers.slice();
    state.freedom = plan.freedom;
    state.slack = plan.slack;
    dom.status.textContent = plan.feasible
      ? `已生成答卷：为目标类型 ${plan.type} 反推出 ${data.nItems} 题作答${plan.fromSample ? '（取自真实样本库）' : ''}（耗时 ${Date.now() - started} ms）。`
      : `反推未完全命中（得到 ${plan.type}，目标 ${plan.requested.__type || type}）。`;
    dom.status.className = plan.feasible ? 'status ok' : 'status bad';
    renderTypologyProfile(plan);
    renderTypologyAnswers(plan);
    renderItemBank();
    dom.results.hidden = false;
    refreshSolveButton();
  }, 30);
}

function renderTypologyProfile(plan) {
  const data = currentData();
  const t = plan.type;
  const tMeta = (MBTI_TYPES_16 || []).find((x) => x.id === t) || null;
  const dimRows = data.scales
    .map((sc) => {
      const d = plan.dims[sc.name];
      const A = sc.pair[0];
      const B = sc.pair[1];
      const letter = d.letter;
      const isX = letter === 'X';
      const aPct = d.total ? Math.round((d.a / d.total) * 100) : 50;
      const bar = `<span class="bar"><span class="bar-fill dim-${letter.toLowerCase()}" style="width:${aPct}%"></span></span>`;
      return (
        `<tr${isX ? ' class="mid"' : ''}>` +
        `<td class="abbr">${sc.name}</td>` +
        `<td class="dim-${A.toLowerCase()}">${A} ${LETTER_CN[A] || ''}</td>` +
        `<td class="dim-${B.toLowerCase()}">${B} ${LETTER_CN[B] || ''}</td>` +
        `<td class="dim-${letter.toLowerCase()}">${letter}</td>` +
        `<td>${bar}</td></tr>`
      );
    })
    .join('');
  const badge = `<span class="typ-badge dim-${t[0].toLowerCase()}">${t}</span>`;
  const html =
    `<div class="typ-result">` +
    `<div class="typ-head">${badge}` +
    `${tMeta ? `<span class="typ-name">${escapeHtml(tMeta.name || '')}</span>` : ''}` +
    `${plan.fromSample ? '<span class="badge">真实样本</span>' : ''}</div>` +
    (tMeta && tMeta.category ? `<div class="typ-cat">${escapeHtml(tMeta.category)}</div>` : '') +
    `<table class="typ-dims"><tr><th>维度</th><th>左</th><th>右</th><th>类型</th><th>倾向</th></tr>${dimRows}</table>` +
    `</div>`;
  dom.profile.innerHTML = html;
}

function renderTypologyAnswers(plan) {
  const data = currentData();
  const parts = [];
  const showText = dom.showText ? dom.showText.checked : false;
  const zhA = data.items.zhA || [];
  const zhB = data.items.zhB || [];
  for (let item = 1; item <= data.nItems; item += 1) {
    const ans = state.answers[item - 1] ? 1 : 0; // 0=A, 1=B
    const [letterA, letterB] = data.itemOptions[item - 1] || ['', ''];
    const stem = data.items.zh ? data.items.zh[item - 1] : '';
    const aText = zhA[item - 1] || '';
    const bText = zhB[item - 1] || '';
    const title = [stem, `A：${aText}`, `B：${bText}`].filter(Boolean).join('\n');
    // 二选一：直接展示两个选项各自文本，点击选中；维度色只作标识，不再把维度字母当选项
    parts.push(
      `<div class="cell typ ${ans === 0 ? 'is-a' : 'is-b'}"` +
      ` data-item="${item}" title="${escapeAttr(title)}">` +
      `<span class="n">${item}</span>` +
      `<span class="opt${ans === 0 ? ' on' : ''}" data-opt="0">` +
        `<em style="background:var(--mbti-${String(letterA || 'e').toLowerCase()})">A</em>${escapeHtml(aText)}</span>` +
      `<span class="opt${ans === 1 ? ' on' : ''}" data-opt="1">` +
        `<em style="background:var(--mbti-${String(letterB || 'e').toLowerCase()})">B</em>${escapeHtml(bText)}</span>` +
      (showText ? `<span class="q">${escapeHtml(stem)}</span>` : '') +
      '</div>'
    );
  }
  dom.answers.innerHTML = parts.join('');
  dom.answers.classList.toggle('with-text', showText);
  // MBTI 作答格逐格错峰浮现（上限封顶，避免大题本拖太久）
  dom.answers.querySelectorAll('.cell').forEach((c, i) => {
    c.classList.add('cell-in');
    c.style.animationDelay = `${Math.min(i, 30) * 10}ms`;
  });
  dom.freeCount.textContent = `${data.nItems} 题（点击选项切换）`;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
