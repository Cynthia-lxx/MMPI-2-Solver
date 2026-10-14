/**
 * MMPI-2 inverse solver -- JS port of mmpi2/inverse.py.
 *
 * The forward map  f : {0,1}^567 -> Z^87  (answers -> T scores) is all integer
 * counting, so it is a linear model plus two non-linearities:
 *
 *     raw_S = base_S + sum_{i answered True} delta_{i,S}     delta in {-1,0,+1}
 *     K correction : raw_S <- round(raw_S + c_S * raw_K)
 *     T_S          = table_S[raw_S]                          (monotone step)
 *
 * Flipping one item therefore moves each scale by -1, 0 or +1, and only the
 * scales keying that item (plus the five K-corrected scales when K itself
 * moves, plus any VRIN/TRIN pair containing it) need recomputing -- which is
 * what makes local search over 2^567 answer sheets affordable.
 *
 * Usage (browser or Node):
 *
 *     import { MMPI2_DATA } from './data.js';
 *     import { solve, scoreAnswers, scaleOptions } from './inverse.js';
 *
 *     const options = scaleOptions({ isMale: true });      // dropdown values
 *     const result  = solve({ Hs: 70, Sc: 81 }, { isMale: true, seed: 1 });
 *     result.loss                                          // 0 = target hit
 *     scoreAnswers(result.answers, { isMale: true }).byName // verify
 */

import { MMPI2_DATA } from './data.js';

export { MMPI2_DATA };

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

/** Deterministic PRNG (mulberry32) so runs are reproducible like Python's seed. */
export function makeRng(seed = 0) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clampLookup(table, raw) {
  return raw >= 0 && raw < table.length ? table[raw] : table[table.length - 1];
}

/**
 * Round half to even.  JS Math.round() rounds half up, which would disagree
 * with Python's round() / C#'s Convert.ToInt32() (12.5 -> 12, 13.5 -> 14) and
 * shift every K-corrected scale by a point.
 */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Nearest value of `values` to `want`; ties go down, matching Python's audit. */
export function nearestReachable(values, want) {
  let best = values[0];
  let bestGap = Math.abs(values[0] - want);
  for (const v of values) {
    const gap = Math.abs(v - want);
    if (gap < bestGap) {
      best = v;
      bestGap = gap;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * model
 * ------------------------------------------------------------------ */

export class InverseModel {
  constructor(data = MMPI2_DATA, options = {}) {
    const { isMale = true, correctInconsistency = false } = options;
    this.data = data;
    this.isMale = isMale;
    this.correct = correctInconsistency;

    const genderBlock = isMale ? data.male : data.female;
    this.keys = genderBlock.keys;
    this.tables = genderBlock.tables;
    this.slots = data.scales;
    this.nameToFlat = new Map(this.slots.map((s) => [s.name, s.flat]));

    this.kFlat = data.kFlat;
    this.vrinFlat = data.vrinFlat;
    this.trinFlat = data.trinFlat;
    this.kCorrections = new Map(
      Object.entries(data.kCorrections).map(([flat, coef]) => [Number(flat), coef])
    );
    this.nScales = data.nScales;
    this.nItems = data.nItems;

    const resp = data.response;
    this.vrinPairs = resp.vrinPairs;
    this.vrinExpected = resp.vrinExpected;
    this.truePairs = resp.truePairs;
    this.falsePairs = resp.falsePairs;
    this.nVrinPairs = this.vrinPairs.length / 2;

    this._buildLinearModel();
    this._buildPairMembership();
    this.reset();
  }

  /** base[flat] = score of the all-False sheet; deltas[item] = [[flat, +/-1]]. */
  _buildLinearModel() {
    const n = this.nScales;
    this.base = new Array(n).fill(0);
    this.deltas = Array.from({ length: this.nItems + 1 }, () => []);

    const slotOf = new Map();
    for (const slot of this.slots) {
      if (slot.kind === 'keyed') slotOf.set(`${slot.family}:${slot.p}`, slot);
    }
    for (let family = 0; family < this.keys.length; family += 1) {
      const arrays = this.keys[family];
      for (let p = 0; p < arrays.length / 2; p += 1) {
        const slot = slotOf.get(`${family}:${p}`);
        this.base[slot.flat] = arrays[2 * p + 1].length;
        for (const item of arrays[2 * p]) this.deltas[item].push([slot.flat, +1]);
        for (const item of arrays[2 * p + 1]) this.deltas[item].push([slot.flat, -1]);
      }
    }
  }

  _buildPairMembership() {
    const n = this.nItems + 1;
    this.vrinPairsOf = Array.from({ length: n }, () => []);
    this.trinTruePairsOf = Array.from({ length: n }, () => []);
    this.trinFalsePairsOf = Array.from({ length: n }, () => []);
    for (let j = 0; j < this.vrinPairs.length / 2; j += 1) {
      this.vrinPairsOf[this.vrinPairs[2 * j]].push(j);
      this.vrinPairsOf[this.vrinPairs[2 * j + 1]].push(j);
    }
    for (let j = 0; j < this.truePairs.length / 2; j += 1) {
      this.trinTruePairsOf[this.truePairs[2 * j]].push(j);
      this.trinTruePairsOf[this.truePairs[2 * j + 1]].push(j);
    }
    for (let j = 0; j < this.falsePairs.length / 2; j += 1) {
      this.trinFalsePairsOf[this.falsePairs[2 * j]].push(j);
      this.trinFalsePairsOf[this.falsePairs[2 * j + 1]].push(j);
    }
  }

  reset(answers = null) {
    const n = this.nItems;
    this.answers = answers
      ? Array.from({ length: n }, (_, i) => answers[i] === true)
      : new Array(n).fill(false);

    this.raws = this.base.slice();
    for (let i = 0; i < n; i += 1) {
      if (!this.answers[i]) continue;
      for (const [flat, d] of this.deltas[i + 1]) this.raws[flat] += d;
    }

    let vrin = 0;
    for (let j = 0; j < this.nVrinPairs; j += 1) vrin += this._vrinHit(j) ? 1 : 0;
    let tt = 0;
    for (let j = 0; j < this.truePairs.length / 2; j += 1) tt += this._trinHit(j, true) ? 1 : 0;
    let tf = 0;
    for (let j = 0; j < this.falsePairs.length / 2; j += 1) tf += this._trinHit(j, false) ? 1 : 0;
    this.vrinConsistent = vrin;
    this.trinTrue = tt;
    this.trinFalse = tf;

    this.ts = new Array(this.nScales);
    for (let flat = 0; flat < this.nScales; flat += 1) this.ts[flat] = this._computeT(flat);
    return this;
  }

  _vrinHit(j) {
    const a = this.answers[this.vrinPairs[2 * j] - 1];
    const b = this.answers[this.vrinPairs[2 * j + 1] - 1];
    return a === this.vrinExpected[2 * j] && b === this.vrinExpected[2 * j + 1];
  }

  _trinHit(j, wantTrue) {
    const pair = wantTrue ? this.truePairs : this.falsePairs;
    return this.answers[pair[2 * j] - 1] === wantTrue && this.answers[pair[2 * j + 1] - 1] === wantTrue;
  }

  _computeT(flat) {
    const slot = this.slots[flat];
    let raw;
    if (slot.kind === 'vrin') {
      raw = this.correct ? this.nVrinPairs - this.vrinConsistent : this.vrinConsistent;
    } else if (slot.kind === 'trin') {
      raw = this.correct
        ? 9 + this.trinTrue - this.trinFalse
        : 9 + this.trinTrue + this.trinFalse;
    } else {
      raw = this.raws[flat];
    }
    const coef = this.kCorrections.get(flat);
    if (coef !== undefined) raw = roundHalfEven(raw + coef * this.raws[this.kFlat]);
    return clampLookup(this.tables[slot.family][slot.y], raw);
  }

  /** Flip item (1-based) in place; symmetric, so calling it again undoes it. */
  _mutate(item) {
    const i = item - 1;
    const oldVrin = this.vrinPairsOf[item].map((j) => (this._vrinHit(j) ? 1 : 0));
    const oldTrue = this.trinTruePairsOf[item].map((j) => (this._trinHit(j, true) ? 1 : 0));
    const oldFalse = this.trinFalsePairsOf[item].map((j) => (this._trinHit(j, false) ? 1 : 0));

    this.answers[i] = !this.answers[i];
    const sign = this.answers[i] ? 1 : -1;
    for (const [flat, d] of this.deltas[item]) this.raws[flat] += sign * d;

    this.vrinPairsOf[item].forEach((j, k) => {
      this.vrinConsistent += (this._vrinHit(j) ? 1 : 0) - oldVrin[k];
    });
    this.trinTruePairsOf[item].forEach((j, k) => {
      this.trinTrue += (this._trinHit(j, true) ? 1 : 0) - oldTrue[k];
    });
    this.trinFalsePairsOf[item].forEach((j, k) => {
      this.trinFalse += (this._trinHit(j, false) ? 1 : 0) - oldFalse[k];
    });
  }

  /** Scales whose T score can change when `item` flips. */
  _touched(item) {
    const flats = new Set(this.deltas[item].map(([flat]) => flat));
    if (this.vrinPairsOf[item].length) flats.add(this.vrinFlat);
    if (this.trinTruePairsOf[item].length || this.trinFalsePairsOf[item].length) {
      flats.add(this.trinFlat);
    }
    if (flats.has(this.kFlat)) for (const flat of this.kCorrections.keys()) flats.add(flat);
    return flats;
  }

  /**
   * For each item, the targeted scales that flipping it would disturb.
   *
   * Structural, not "flip it once and see": T_S depends only on raw_S (plus
   * raw_K for the five corrected scales), so an item keyed to none of the
   * targeted scales can never move them -- no matter what the rest of the
   * sheet looks like.  That is the guarantee behind "2 ** n combinations":
   * the free items are genuinely free simultaneously, not one at a time.
   * (A weaker test -- flipping one item in the current sheet -- would call
   * items sitting on a plateau of the step function free, and then flipping
   * two of them at once could still cross out of the plateau.)
   *
   * `flats` are flat scale indices.  Returns an array indexed 1..nItems of
   * [{name, viaK}].
   */
  itemLocks(flats) {
    const watched = new Set(flats);
    const kMatters = [...watched].some((flat) => this.kCorrections.has(flat));
    const locks = new Array(this.nItems + 1);

    for (let item = 1; item <= this.nItems; item += 1) {
      const reasons = [];
      for (const [flat] of this.deltas[item]) {
        if (watched.has(flat)) {
          reasons.push({ name: this.slots[flat].name, viaK: false });
        } else if (kMatters && flat === this.kFlat) {
          for (const corrected of this.kCorrections.keys()) {
            if (watched.has(corrected)) {
              reasons.push({ name: this.slots[corrected].name, viaK: true });
            }
          }
        }
      }
      if (watched.has(this.vrinFlat) && this.vrinPairsOf[item].length) {
        reasons.push({ name: 'VRIN', viaK: false });
      }
      if (
        watched.has(this.trinFlat) &&
        (this.trinTruePairsOf[item].length || this.trinFalsePairsOf[item].length)
      ) {
        reasons.push({ name: 'TRIN', viaK: false });
      }
      locks[item] = reasons;
    }
    return locks;
  }

  /** Boolean version of itemLocks(): true where the item affects no target. */
  itemFreedom(flats) {
    const locks = this.itemLocks(flats);
    const freedom = new Array(this.nItems + 1).fill(false);
    for (let item = 1; item <= this.nItems; item += 1) freedom[item] = locks[item].length === 0;
    return freedom;
  }

  /** Snapshot of the current T scores, grouped by family (like the Python API). */
  tscores() {
    const out = this.data.abbreviations.map(() => []);
    for (const slot of this.slots) out[slot.family][slot.y] = this.ts[slot.flat];
    return out;
  }

  byName() {
    const out = {};
    for (const slot of this.slots) out[slot.name] = this.ts[slot.flat];
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * forward scoring (independent of the incremental model)
 * ------------------------------------------------------------------ */

/**
 * Straightforward forward pass, mirroring mmpi2/scoring.py.  Kept separate
 * from InverseModel on purpose: the tests assert the two agree.
 */
export function scoreAnswers(answers, options = {}) {
  const { isMale = true, correctInconsistency = false, data = MMPI2_DATA } = options;
  const block = isMale ? data.male : data.female;
  const keys = block.keys;
  const tables = block.tables;

  const totals = keys.map((arrays) => {
    const out = [];
    for (let y = 0; y < arrays.length; y += 2) {
      let subtotal = 0;
      for (const item of arrays[y]) if (answers[item - 1] === true) subtotal += 1;
      for (const item of arrays[y + 1]) if (answers[item - 1] === false) subtotal += 1;
      out.push(subtotal);
    }
    return out;
  });

  // VRIN
  const vrinPairs = data.response.vrinPairs;
  const vrinExpected = data.response.vrinExpected;
  let consistent = 0;
  for (let i = 0; i < vrinPairs.length; i += 2) {
    if (
      answers[vrinPairs[i] - 1] === vrinExpected[i] &&
      answers[vrinPairs[i + 1] - 1] === vrinExpected[i + 1]
    ) {
      consistent += 1;
    }
  }
  const vrin = correctInconsistency ? vrinPairs.length / 2 - consistent : consistent;

  // TRIN
  const truePairs = data.response.truePairs;
  const falsePairs = data.response.falsePairs;
  let bothTrue = 0;
  for (let i = 0; i < truePairs.length; i += 2) {
    if (answers[truePairs[i] - 1] === true && answers[truePairs[i + 1] - 1] === true) bothTrue += 1;
  }
  let bothFalse = 0;
  for (let i = 0; i < falsePairs.length; i += 2) {
    if (answers[falsePairs[i] - 1] === false && answers[falsePairs[i + 1] - 1] === false) {
      bothFalse += 1;
    }
  }
  const trin = correctInconsistency ? 9 + bothTrue - bothFalse : 9 + bothTrue + bothFalse;
  totals[4].splice(5, 0, vrin, trin);

  // K correction + table lookup
  const rawK = totals[0][2];
  const kCorrections = new Map(
    Object.entries(data.kCorrections).map(([y, coef]) => [Number(y), coef])
  );
  // keep the pre-lookup raws: the exported profile sheet needs them
  const raws = totals.map((row) => row.slice());
  const flat = [];
  const rawFlat = [];
  for (let x = 0; x < totals.length; x += 1) {
    for (let y = 0; y < totals[x].length; y += 1) {
      let raw = totals[x][y];
      if (x === 0 && kCorrections.has(y)) raw = roundHalfEven(raw + kCorrections.get(y) * rawK);
      raws[x][y] = raw;
      totals[x][y] = clampLookup(tables[x][y], raw);
      flat.push(totals[x][y]);
      rawFlat.push(raw);
    }
  }

  const byName = {};
  const rawByName = {};
  data.scales.forEach((slot) => {
    byName[slot.name] = flat[slot.flat];
    rawByName[slot.name] = rawFlat[slot.flat];
  });
  return { tscores: totals, flat, byName, raws, rawByName };
}

/* ------------------------------------------------------------------ *
 * reachable values / scale options for the GUI
 * ------------------------------------------------------------------ */

/** {name: {values, min, max, gaps, gapCount, sparse}} for one gender. */
export function reachableValues(isMale = true, data = MMPI2_DATA) {
  return data.reachable[isMale ? 'male' : 'female'];
}

/**
 * All 87 scales with their selectable T values -- what a GUI builds its
 * dropdowns from.  Every scale has gaps, so `values` is the only safe source.
 */
export function scaleOptions(options = {}) {
  const { isMale = true, data = MMPI2_DATA } = options;
  const reachable = reachableValues(isMale, data);
  return data.scales.map((slot) => ({
    name: slot.name,
    fullName: slot.fullName,
    family: data.families[slot.family],
    kind: slot.kind,
    ...reachable[slot.name],
  }));
}

/** Is this T score reachable, and if not what is the nearest one that is? */
export function auditTargets(targets, options = {}) {
  const { isMale = true, data = MMPI2_DATA } = options;
  const reachable = reachableValues(isMale, data);
  const report = {};
  for (const [name, want] of Object.entries(targets)) {
    const info = reachable[name];
    if (!info) throw new Error(`unknown scale ${name}`);
    const inTable = info.values.includes(want);
    report[name] = {
      want,
      inTable,
      nearest: inTable ? want : nearestReachable(info.values, want),
      nearestBelow: info.values.filter((v) => v < want).pop() ?? null,
      nearestAbove: info.values.find((v) => v > want) ?? null,
      tableMin: info.min,
      tableMax: info.max,
    };
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * solver
 * ------------------------------------------------------------------ */

function itemsOfScale(model, flat) {
  const slot = model.slots[flat];
  if (slot.kind === 'keyed') {
    const arrays = model.keys[slot.family];
    return [...arrays[2 * slot.p], ...arrays[2 * slot.p + 1]];
  }
  if (slot.kind === 'vrin') return [...model.vrinPairs];
  return [...model.truePairs, ...model.falsePairs];
}

/**
 * Find an answer sheet hitting `targets` ({scale name: T score}).
 *
 * Options: isMale, correctInconsistency, weights, tol, exponent, start,
 * iterations, seed, t0, t1, restrictCandidates, polish, snapToReachable.
 * `snapToReachable` rewrites unreachable targets to the nearest value the
 * table can produce before searching -- handy when a GUI lets a value through.
 */
export function solve(targets, options = {}) {
  const {
    isMale = true,
    correctInconsistency = false,
    weights = null,
    tol = 0,
    exponent = 1,
    start = null,
    iterations = 200000,
    seed = 0,
    t0 = 6,
    t1 = 0.05,
    restrictCandidates = true,
    polish = true,
    snapToReachable = false,
    data = MMPI2_DATA,
  } = options;

  let wanted = { ...targets };
  if (snapToReachable) {
    const audit = auditTargets(wanted, { isMale, data });
    wanted = Object.fromEntries(
      Object.entries(wanted).map(([name, value]) => [name, audit[name].nearest])
    );
  }

  const model = new InverseModel(data, { isMale, correctInconsistency });
  const targetFlat = new Map();
  for (const [name, value] of Object.entries(wanted)) {
    const flat = model.nameToFlat.get(name);
    if (flat === undefined) throw new Error(`unknown scale ${name}`);
    targetFlat.set(flat, Math.trunc(value));
  }
  const weightFlat = new Map(
    Object.entries(weights || {}).map(([name, w]) => [model.nameToFlat.get(name), w])
  );

  const penalty = (flat) => {
    if (!targetFlat.has(flat)) return 0;
    const gap = Math.abs(model.ts[flat] - targetFlat.get(flat)) - tol;
    if (gap <= 0) return 0;
    return gap ** exponent * (weightFlat.get(flat) ?? 1);
  };

  model.reset(start);
  let loss = 0;
  for (const flat of targetFlat.keys()) loss += penalty(flat);

  let items;
  if (restrictCandidates) {
    const set = new Set();
    for (const flat of targetFlat.keys()) for (const item of itemsOfScale(model, flat)) set.add(item);
    // Hs / Pd / Pt / Sc / Ma are K-corrected, so raw K moves them too: without
    // K's own items the solver cannot adjust the correction and sits one step
    // away from plenty of reachable targets (Hs 70 was unreachable before).
    if ([...targetFlat.keys()].some((flat) => model.kCorrections.has(flat))) {
      for (const item of itemsOfScale(model, model.kFlat)) set.add(item);
    }
    items = [...set].sort((a, b) => a - b);
  } else {
    items = Array.from({ length: model.nItems }, (_, i) => i + 1);
  }
  if (!items.length) items = Array.from({ length: model.nItems }, (_, i) => i + 1);

  const rng = makeRng(seed);
  let bestAnswers = model.answers.slice();
  let bestLoss = loss;
  let moved = 0;
  const cooling = Math.log(t1 / t0);

  for (let step = 0; step < iterations; step += 1) {
    const temperature = t0 * Math.exp(cooling * (step / Math.max(1, iterations - 1)));
    const item = items[Math.floor(rng() * items.length)];
    const touched = model._touched(item);
    const before = new Map();
    let beforePen = 0;
    for (const flat of touched) {
      before.set(flat, model.ts[flat]);
      beforePen += penalty(flat);
    }
    model._mutate(item);
    for (const flat of touched) model.ts[flat] = model._computeT(flat);
    let afterPen = 0;
    for (const flat of touched) afterPen += penalty(flat);
    const delta = afterPen - beforePen;

    if (delta <= 0 || rng() < Math.exp(-delta / temperature)) {
      loss += delta;
      moved += 1;
      if (loss < bestLoss) {
        bestLoss = loss;
        bestAnswers = model.answers.slice();
      }
    } else {
      model._mutate(item);
      for (const [flat, value] of before) model.ts[flat] = value;
    }
    if (bestLoss === 0 && !polish) break;
  }

  if (polish && bestLoss > 0) {
    model.reset(bestAnswers);
    loss = 0;
    for (const flat of targetFlat.keys()) loss += penalty(flat);
    let improved = true;
    let rounds = 0;
    while (improved && rounds < 40) {
      improved = false;
      rounds += 1;
      const order = items.slice();
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const item of order) {
        const touched = model._touched(item);
        const before = new Map();
        let beforePen = 0;
        for (const flat of touched) {
          before.set(flat, model.ts[flat]);
          beforePen += penalty(flat);
        }
        model._mutate(item);
        for (const flat of touched) model.ts[flat] = model._computeT(flat);
        let afterPen = 0;
        for (const flat of touched) afterPen += penalty(flat);
        const delta = afterPen - beforePen;
        if (delta < 0) {
          loss += delta;
          moved += 1;
          improved = true;
        } else {
          model._mutate(item);
          for (const [flat, value] of before) model.ts[flat] = value;
        }
      }
      if (loss < bestLoss) {
        bestLoss = loss;
        bestAnswers = model.answers.slice();
      }
      if (bestLoss === 0) break;
    }
  }

  model.reset(bestAnswers);
  const achieved = model.byName();
  const residual = {};
  for (const [name, want] of Object.entries(wanted)) residual[name] = achieved[name] - want;

  return {
    answers: model.answers.slice(),
    loss: bestLoss,
    achieved,
    target: { ...wanted },
    requested: { ...targets },
    residual,
    iterations: moved,
    isMale,
    correctInconsistency,
    feasible: bestLoss === 0,
    audit: auditTargets(wanted, { isMale, data }),
    verify() {
      const forward = scoreAnswers(this.answers, { isMale, correctInconsistency, data }).byName;
      return Object.entries(this.achieved).every(([name, value]) => forward[name] === value);
    },
  };
}
