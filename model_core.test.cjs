const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('dca_model.html', 'utf8');
const marker = '<script type="text/plain" id="simulation-worker">';
const start = html.indexOf(marker) + marker.length;
const source = html.slice(start, html.indexOf('</script>', start));
let completed;
const sandbox = {
  self: {
    postMessage(message) {
      if (message.type === 'done') completed = message.result;
      if (message.type === 'error') throw new Error(message.message);
    },
  },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const base = {
  monthly: 10,
  initial: 100,
  years: 1,
  growth: 0,
  inflation: 0,
  weights: [100, 0, 0],
  reinvest: true,
  rebal: false,
  sims: 3,
  fxOn: false,
  muQ: 0,
  volQ: 0,
  muS: 0,
  volS: 0,
  rho: 0,
  divV: 0,
  feeV: 0,
  divQ: 0,
  feeQ: 0,
  borrow: 0,
  divJ: 0,
  feeJ: 0,
  betaJ: 0.8,
  capJ: 4,
  alphaJ: 0,
  fxMu: 0,
  fxVol: 0,
  fxCorr: 0,
  whTax: 0,
  cgTax: 0,
  deduction: 250,
  seed: 'test-seed',
};

function run(overrides = {}) {
  completed = undefined;
  sandbox.simulate({ ...base, ...overrides });
  assert.ok(completed, 'simulation did not return a result');
  return completed;
}

function close(actual, expected, tolerance = 1e-8) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

// External contributions must not create performance.
const flat = run();
for (let i = 0; i < flat.N; i += 1) {
  close(flat.finGross[i], 220);
  close(flat.finNet[i], 220);
  close(flat.twr[i], 0);
  close(flat.mdd[i], 0);
  close(flat.taxTotal[i], 0);
}

// A 100% VOO portfolio must match the paired VOO benchmark path-for-path.
const paired = run({
  sims: 5,
  muS: 9,
  volS: 16,
  divV: 1.3,
  feeV: 0.03,
  fxOn: true,
  fxVol: 10,
  fxCorr: -0.25,
  whTax: 15,
  cgTax: 22,
});
for (let i = 0; i < paired.N; i += 1) {
  close(paired.finNet[i], paired.benchFinNet[i]);
  close(paired.twr[i], paired.benchTwr[i]);
  close(paired.mdd[i], paired.benchMdd[i]);
  close(paired.taxTotal[i], paired.benchTaxTotal[i]);
}

// QLD daily reset must preserve path dependence.
const qldTwoDay = (1 + sandbox.qldDailyReturn(0.10, 0, 0))
  * (1 + sandbox.qldDailyReturn(-0.090909090909, 0, 0)) - 1;
close(qldTwoDay, -0.0181818181816, 1e-10);

// Acquisition-basis tax: (1400 - 1000 - 250) * 22% = 33.
close(sandbox.liquidationTax({ h: [1400], basis: [1000], realizedYTD: 0 }, 250, 0.22), 33);

// Pure FX appreciation compounds multiplicatively into KRW wealth.
const fx = run({ monthly: 0, initial: 1000, fxOn: true, fxMu: 10, fxVol: 0 });
close(fx.finGross[0], 1100, 1e-6);

// Dividends are carved out once; withholding is the only drag in this case.
const dividend = run({ monthly: 0, initial: 1000, divV: 12, whTax: 15 });
const expectedDividendWealth = 1000 * Math.pow(1 - 0.03 * 0.15, 4);
close(dividend.finGross[0], expectedDividendWealth, 1e-6);
close(dividend.twr[0], expectedDividendWealth / 1000 - 1, 1e-8);
assert.ok(dividend.mdd[0] < 0, 'withholding drag must appear in drawdown');

// Deterministic capital gain and annual deduction.
const taxed = run({ monthly: 0, initial: 1000, muS: 50, cgTax: 22, deduction: 250 });
close(taxed.finGross[0], 1500, 1e-6);
close(taxed.taxTotal[0], 55, 1e-6);
close(taxed.finNet[0], 1445, 1e-6);

// Same inputs and seed must reproduce exactly.
const first = run({ sims: 4, muS: 9, volS: 16, seed: 'repeatable' });
const second = run({ sims: 4, muS: 9, volS: 16, seed: 'repeatable' });
assert.deepEqual(Array.from(first.finNet), Array.from(second.finNet));
assert.deepEqual(Array.from(first.paths), Array.from(second.paths));

// Full-model smoke test with the page defaults.
const smoke = run({
  monthly: 100,
  initial: 0,
  years: 15,
  weights: [50, 20, 30],
  sims: 100,
  fxOn: true,
  muQ: 11,
  volQ: 22,
  muS: 9,
  volS: 16,
  rho: 0.9,
  divV: 1.3,
  feeV: 0.03,
  divQ: 0.3,
  feeQ: 0.95,
  borrow: 4,
  divJ: 10,
  feeJ: 0.35,
  betaJ: 0.8,
  capJ: 4,
  alphaJ: 7,
  fxMu: 0,
  fxVol: 10,
  fxCorr: -0.25,
  whTax: 15,
  cgTax: 22,
  deduction: 250,
  seed: '20260916',
});
for (let i = 0; i < smoke.N; i += 1) {
  assert.ok(Number.isFinite(smoke.finNet[i]) && smoke.finNet[i] >= 0);
  assert.ok(Number.isFinite(smoke.twr[i]));
  assert.ok(smoke.mdd[i] <= 0 && smoke.mdd[i] >= -1);
  assert.ok(Number.isFinite(smoke.taxTotal[i]) && smoke.taxTotal[i] >= 0);
}

console.log('model core tests passed');
