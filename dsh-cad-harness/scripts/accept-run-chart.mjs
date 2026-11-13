// Acceptance for the run chart (the simulation's missing time axis).
//
// The regression: the i18n pass imported `t as tr` in run-chart.ts while the
// body already used `const tr = report?.trajectory`. The local variable shadowed
// the translator, so every motion/physics playback with a trajectory threw
// "tr is not a function" and the whole playback view failed to render (the data
// strip and viewport disappeared with it). Keep the two names distinct.
//
//   node scripts/accept-run-chart.mjs
import { en, setCadTranslator } from '../src/client/i18n.ts';
import { buildRunChart } from '../src/client/run-chart.ts';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
setCadTranslator((key, vars = {}) => String(en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)));

const motionReport = {
  keyframes: [{ timeSec: 0, label: 'start' }, { timeSec: 1, label: 'end' }],
  metrics: {
    followers: { slide: { axis: 'z', travelMm: 10 } },
    interferenceEvents: [{ timeSec: 0.5, partA: 'slide', partB: 'base' }],
  },
  trajectory: {
    times: [0, 0.5, 1],
    parts: [{ name: 'slide', frames: [[0, 0, 0], [0, 0, 5], [0, 0, 10]] }],
    events: [{ timeSec: 0.5, label: 'contact' }],
  },
};

const chart = buildRunChart('motion', motionReport);
check('a motion trajectory builds a chart instead of throwing', chart !== null);
check('the chart carries a translated title', typeof chart?.title === 'string' && chart.title.length > 0, chart?.title);
check('the chart carries the follower series', chart?.series?.[0]?.name === 'slide' && chart.series[0].values.at(-1) === 10,
  JSON.stringify(chart?.series?.[0]?.values));
check('the chart keeps the report keyframes', chart?.keyframes?.length === 2, String(chart?.keyframes?.length));
check('the chart carries the time-series note', typeof chart?.note === 'string' && chart.note.length > 0, chart?.note);

check('a report without a trajectory returns null', buildRunChart('motion', { metrics: {} }) === null);
check('a trajectory with one sample returns null (nothing to plot)', buildRunChart('motion', {
  trajectory: { times: [0], parts: [{ name: 'a', frames: [[0, 0, 0]] }] },
}) === null);

console.log(`\naccept-run-chart: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
