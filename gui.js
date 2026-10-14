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

export { MMPI2_DATA };
export { itemText, cnT, usTForCn60, buildSheets, serialize, parseAnswers, EXPORT_CONTENTS, EXPORT_FORMATS };

export const FAMILY_LABELS = {
  basic: '基本量表（效度 + 临床）',
  harris_lingoes: 'Harris–Lingoes 亚量表',
  wiener_harmon: 'Wiener–Harmon 亚量表',
  si: 'Si 亚量表',
  supplemental: '补充量表（含 VRIN / TRIN）',
};

export const FAMILY_ORDER = ['basic', 'harris_lingoes', 'wiener_harmon', 'si', 'supplemental'];

export const ITERATION_PRESETS = { quick: 60000, standard: 200000, deep: 600000 };

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
  // solve() only knows the raw table, which over-promises for VRIN and TRIN
  const wanted = {};
  for (const [name, value] of Object.entries(targets)) {
    const list = reachableValuesFor(name, isMale, correctInconsistency, data);
    wanted[name] = list.includes(value) ? value : nearestReachable(list, value);
  }

  const result = solve(wanted, {
    isMale,
    correctInconsistency,
    iterations,
    seed,
    snapToReachable,
    start: start || startSheet(wanted, { correctInconsistency, isMale, data }),
    data,
  });

  const model = new InverseModel(data, { isMale, correctInconsistency });
  model.reset(result.answers);
  const locks = model.itemLocks(names.map((name) => model.nameToFlat.get(name)));

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

  const scored = scoreAnswers(result.answers, { isMale, correctInconsistency, data });

  return {
    answers: result.answers,
    achieved: result.achieved,
    target: result.target,
    requested: { ...targets }, // what the user asked for, before snapping
    residual: result.residual,
    loss: result.loss,
    feasible: result.feasible,
    audit: result.audit,
    freedom,
    freeItems,
    lockedItems,
    lockReason,
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

/** Human-readable count of how many answer sheets realise the profile. */
export function combinationLabel(n) {
  if (n === 0) return '唯一解（无自由题）';
  if (n <= 48) return `${(2 ** n).toLocaleString('en-US')} 种组合`;
  return `约 10^${(n * Math.log10(2)).toFixed(0)} 种组合`;
}

/**
 * Parse "Hs=70" / "Sc 81" / "Pt:74" lines into targets.
 * Values outside the T table are reported, not silently rejected.
 */
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
    const m = token.match(/^([A-Za-z0-9_]+)\s*[:=\s]\s*(\d{1,3})$/);
    if (!m) {
      unknown.push(token);
      continue;
    }
    const name = lookup.get(m[1].toLowerCase());
    if (!name) {
      unknown.push(token);
      continue;
    }
    const value = Number(m[2]);
    if (!reachable[name].values.includes(value)) {
      unreachable.push(`${name} ${value} → ${nearestReachable(reachable[name].values, value)}`);
    }
    targets[name] = value;
  }
  return { targets, unknown, unreachable };
}

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const state = {
  isMale: true,
  correctInconsistency: false,
  iterations: ITERATION_PRESETS.standard,
  seed: 1,
  options: {},
  targets: {},
  plan: null,
  answers: null,
  freedom: null,
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

function buildScaleList() {
  const byFamily = new Map(FAMILY_ORDER.map((f) => [f, []]));
  for (const option of optionsFor(state.isMale, state.correctInconsistency)) {
    byFamily.get(option.family).push(option);
  }

  const html = FAMILY_ORDER.map((family) => {
    const rows = byFamily.get(family)
      .map((option) => {
        const selected = state.targets[option.name];
        const values = option.values
          .map((v) => `<option value="${v}"${v === selected ? ' selected' : ''}>${v}</option>`)
          .join('');
        return (
          `<div class="row" data-name="${option.name}" data-search="${option.name.toLowerCase()} ${option.fullName.toLowerCase()}">` +
          `<span class="abbr">${option.name}</span>` +
          `<select data-name="${option.name}"><option value="">—</option>${values}</select>` +
          `<span class="full">${option.fullName}</span></div>`
        );
      })
      .join('');
    const open = family === 'basic' ? ' open' : '';
    return (
      `<details class="group"${open}><summary>${FAMILY_LABELS[family]}` +
      `<span class="count">${byFamily.get(family).length}</span></summary>` +
      `<div class="rows">${rows}</div></details>`
    );
  }).join('');

  dom.scaleList.innerHTML = html;
  for (const select of dom.scaleList.querySelectorAll('select')) {
    select.addEventListener('change', onTargetChanged);
  }
  applySearch();
}

function collectTargets() {
  const targets = {};
  for (const select of dom.scaleList.querySelectorAll('select')) {
    if (select.value !== '') targets[select.dataset.name] = Number(select.value);
  }
  return targets;
}

function applyTargets(targets) {
  const byName = new Map(optionsFor(state.isMale, state.correctInconsistency).map((o) => [o.name, o]));
  const notes = [];
  for (const [name, raw] of Object.entries(targets)) {
    const option = byName.get(name);
    if (!option) continue;
    const value = option.values.includes(raw) ? raw : nearestReachable(option.values, raw);
    if (value !== raw) notes.push(`${name}: ${raw} → ${value}`);
    state.targets[name] = value;
  }
  if (notes.length) setNote(`目标值已折算到可取値：${notes.join('，')}`);
  buildScaleList();
}

/** Keep targets valid when the gender or the VRIN / TRIN formula changes. */
function retarget(targets) {
  const byName = new Map(optionsFor(state.isMale, state.correctInconsistency).map((o) => [o.name, o]));
  const kept = {};
  const notes = [];
  for (const [name, value] of Object.entries(targets)) {
    const option = byName.get(name);
    if (!option) continue;
    if (option.values.includes(value)) {
      kept[name] = value;
      continue;
    }
    kept[name] = nearestReachable(option.values, value);
    notes.push(`${name}: ${value} → ${kept[name]}`);
  }
  if (notes.length) setNote(`目标値已折算到当前 T 表的可取値：${notes.join('，')}`);
  return kept;
}

function onTargetChanged(event) {
  const name = event.target.dataset.name;
  if (event.target.value === '') delete state.targets[name];
  else state.targets[name] = Number(event.target.value);
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
    setNote('请先在左侧选择至少一个量表的目标 T 分。');
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
    renderStatus(plan, Date.now() - started);
    renderTargetTable(plan);
    renderProfile(plan.profile);
    renderAnswers(plan);
    dom.results.hidden = false;
    refreshSolveButton();
  }, 30);
}

function renderStatus(plan, ms) {
  const off = Object.entries(plan.residual).filter(([, v]) => v !== 0);
  const snapped = Object.entries(plan.requested).filter(
    ([name, value]) => plan.target[name] !== value
  );
  if (plan.feasible) {
    dom.status.textContent = `完全命中 ${Object.keys(plan.target).length} 个目标（耗时 ${ms} ms）。`;
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
        snapped.map(([name, value]) => `${name} ${value} → ${plan.target[name]}`).join('，')
    );
  }
}

function renderTargetTable(plan) {
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
      const want = plan.requested[name] === plan.target[name]
        ? `${plan.target[name]}`
        : `${plan.requested[name]} → ${plan.target[name]}`;
      return (
        `<tr class="${cls}"><td class="abbr">${name}</td><td>${want}</td>` +
        `<td>${got}</td>${cnCell}` +
        `<td>${gap === 0 ? '0' : (gap > 0 ? '+' : '') + gap}</td></tr>`
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
        const targeted = state.targets[slot.name] !== undefined;
        const level = value >= 80 ? 'hi' : value >= 65 ? 'mid' : '';
        return (
          `<tr class="${targeted ? 'targeted' : ''}">` +
          `<td class="abbr">${slot.name}</td><td class="full">${slot.fullName}</td>` +
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

function renderAnswers(plan) {
  const parts = [];
  const showText = dom.showText ? dom.showText.checked : false;
  for (let item = 1; item <= MMPI2_DATA.nItems; item += 1) {
    const free = state.freedom[item];
    const answer = state.answers[item - 1] ? 'T' : 'F';
    const text = itemText(item);
    const title = [
      `第 ${item} 题：` + (free ? '自由（翻转不影响目标量表）'
        : `锁定（翻转会改变 ${plan.lockReason.get(item).join('、')}）`),
      text.zh,
      text.en,
    ].join('\n');
    parts.push(
      `<div class="cell ${free ? 'free' : 'locked'} ${answer === 'T' ? 'is-t' : 'is-f'}"` +
        ` data-item="${item}" title="${escapeAttr(title)}">` +
        `<span class="n">${item}</span><b>${answer}</b>` +
        (showText ? `<span class="q">${escapeAttr(text.zh)}</span>` : '') +
        '</div>'
    );
  }
  dom.answers.innerHTML = parts.join('');
  dom.answers.classList.toggle('with-text', showText);
  dom.freeCount.textContent = `自由题 ${plan.freeItems.length} 道 · ${combinationLabel(plan.freeItems.length)}`;
}

function onAnswerClick(event) {
  const cell = event.target.closest('.cell');
  if (!cell || !cell.classList.contains('free') || !state.plan) return;
  const item = Number(cell.dataset.item);
  state.answers[item - 1] = !state.answers[item - 1];
  const answer = state.answers[item - 1] ? 'T' : 'F';
  cell.querySelector('b').textContent = answer;
  cell.classList.toggle('is-t', state.answers[item - 1]);
  cell.classList.toggle('is-f', !state.answers[item - 1]);
  renderProfile(
    scoreAnswers(state.answers, {
      isMale: state.isMale,
      correctInconsistency: state.correctInconsistency,
    }).byName
  );
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
  dom.exportContents.innerHTML = EXPORT_CONTENTS.map(
    (item) =>
      `<label class="check"><input type="checkbox" data-content="${item.id}"` +
      `${item.id === 'answers' ? ' checked' : ''}>${item.label}</label>`
  ).join('');
  dom.exportFormat.innerHTML = EXPORT_FORMATS.map(
    (item) => `<option value="${item.id}">${item.label}</option>`
  ).join('');
}

function runExport() {
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
  });
  if (!sheets.length) {
    setNote('这几项都要先求解；只想拿空白模板的话只勾选它。');
    return;
  }
  const out = serialize(sheets, dom.exportFormat.value, { basename: 'mmpi2' });
  if (out.binary) downloadBytes(out.filename, out.body, out.mime);
  else download(out.filename, out.body, out.mime);
  setNote(`已导出 ${out.filename}（${sheets.length} 张表）`);
}

/** Score answers pasted in from a real protocol, without solving anything. */
function runImport() {
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
  dom.results.hidden = true;
  dom.status.textContent = message;
  dom.status.className = 'status';
  refreshSolveButton();
}

function wire() {
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
  dom.solve.addEventListener('click', () => runPlan());
  dom.again.addEventListener('click', () => runPlan({ newSeed: true }));
  dom.shuffle.addEventListener('click', () => {
    if (!state.plan) return;
    state.seed = (state.seed * 1103515245 + 12345) % 2147483647;
    state.answers = randomizeFree(state.answers, state.plan.freeItems, state.seed);
    renderAnswers(state.plan);
    renderProfile(
      scoreAnswers(state.answers, {
        isMale: state.isMale,
        correctInconsistency: state.correctInconsistency,
      }).byName
    );
  });

  dom.copy.addEventListener('click', async () => {
    if (!state.answers) return;
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
}

export function init() {
  const ids = [
    'gender', 'vrin-mode', 'strength', 'note', 'search', 'scale-list', 'bulk', 'bulk-apply',
    'example', 'clear', 'solve', 'again', 'shuffle', 'copy', 'csv', 'status', 'results',
    'target-table', 'profile', 'answers', 'free-count', 'show-text',
    'export-contents', 'export-format', 'export-english', 'export-run-panel',
    'import-text', 'import-file', 'import-score', 'import-target', 'import-note',
  ];
  dom = {};
  for (const id of ids) {
    dom[camel(id)] = document.getElementById(id);
  }
  dom.note.hidden = true;
  dom.results.hidden = true;
  buildScaleList();
  buildExportPanel();
  wire();
  refreshSolveButton();
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
