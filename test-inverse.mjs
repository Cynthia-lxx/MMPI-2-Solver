/**
 * Node harness: prints everything the Python parity test needs as JSON.
 *
 *   node web/test-inverse.mjs
 *
 * It checks the JS side against itself first (incremental model vs. the plain
 * forward pass), then emits scores, reachable values and solver results so
 * tests/test_js_port.py can diff them against the Python implementation.
 */

import { MMPI2_DATA as DATA } from './data.js';
import {
  InverseModel,
  scoreAnswers,
  solve,
  auditTargets,
  scaleOptions,
  roundHalfEven,
} from './inverse.js';

// deterministic, language-independent answer sheets
const lcgSheet = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ((i + offset) * 2654435761) % 997 < 500);

const SHEETS = {
  'all-false': new Array(DATA.nItems).fill(false),
  'all-true': new Array(DATA.nItems).fill(true),
  random: lcgSheet(DATA.nItems),
  'random-b': lcgSheet(DATA.nItems, 7),
};

const out = {
  nItems: DATA.nItems,
  nScales: DATA.nScales,
  scales: DATA.scales.length,
  keysSizes: { male: DATA.male.keys.map((f) => f.length), female: DATA.female.keys.map((f) => f.length) },
  tableSizes: { male: DATA.male.tables.map((f) => f.length), female: DATA.female.tables.map((f) => f.length) },
  rounding: [roundHalfEven(12.5), roundHalfEven(13.5), roundHalfEven(-0.5), roundHalfEven(0.5)],
  forward: {},
  incremental: {},
  reachable: DATA.reachable,
  options: { male: scaleOptions({ isMale: true }), female: scaleOptions({ isMale: false }) },
  audit: {},
  solved: {},
};

// 1. forward scoring, both genders, both VRIN/TRIN formulas
for (const isMale of [true, false]) {
  for (const correct of [false, true]) {
    for (const [label, sheet] of Object.entries(SHEETS)) {
      const key = `${isMale ? 'male' : 'female'}|${correct ? 'fixed' : 'legacy'}|${label}`;
      out.forward[key] = scoreAnswers(sheet, { isMale, correctInconsistency: correct }).flat;
      const model = new InverseModel(DATA, { isMale, correctInconsistency: correct });
      out.incremental[key] = model.reset(sheet).ts.slice();
    }
  }
}

// 2. reachable-value / audit sanity
out.audit = {
  malePt75: auditTargets({ Pt: 75 }, { isMale: true }),
  maleSc80: auditTargets({ Sc: 80 }, { isMale: true }),
  femaleSi65: auditTargets({ Si: 65 }, { isMale: false }),
};

// 3. solve a few profiles; the answers are returned so Python can re-score them
const CASES = [
  { name: 'male-2-scales', targets: { Hs: 70, Sc: 81 }, isMale: true, iterations: 120000, seed: 1 },
  { name: 'female-si', targets: { Si: 65 }, isMale: false, iterations: 60000, seed: 2 },
  // Hs = 81, not 80: the male Hs table jumps 79 -> 81
  { name: 'male-clinical', targets: { Hs: 81, D: 80, Hy: 79, Pd: 79, Pa: 79, Pt: 81, Sc: 81, Ma: 81 }, isMale: true, iterations: 200000, seed: 3 },
  { name: 'male-snap', targets: { Pt: 75, Sc: 80 }, isMale: true, iterations: 60000, seed: 4, snapToReachable: true },
];

for (const c of CASES) {
  const r = solve(c.targets, {
    isMale: c.isMale,
    iterations: c.iterations,
    seed: c.seed,
    snapToReachable: !!c.snapToReachable,
  });
  out.solved[c.name] = {
    target: r.target,
    requested: r.requested,
    achieved: r.achieved,
    residual: r.residual,
    loss: r.loss,
    feasible: r.feasible,
    iterations: r.iterations,
    selfVerify: r.verify(),
    answers: r.answers,
    scoredByForward: scoreAnswers(r.answers, { isMale: c.isMale }).byName,
  };
}

process.stdout.write(JSON.stringify(out));
