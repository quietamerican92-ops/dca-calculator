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
  alphaJ: 0,
  fxMu: 0,
  fxVol: 0,
  fxCorr: 0,
  whTax: 0,
  cgTax: 0,
  deduction: 250,
  seed: 'test-seed',
};

// The engine takes a list of ETFs. Most fixtures below keep the original three-slot shape
// (S&P 500 fund, 2x Nasdaq fund, Nasdaq covered call) and are converted here.
function toEngineConfig(cfg) {
  const { weights, currentHoldings, currentBasis, postWeights, jepqDividendDestination, postJepqDividend,
    divV, feeV, divQ, feeQ, divJ, feeJ, betaJ, alphaJ, ...rest } = cfg;
  const held = currentHoldings ?? [0, 0, 0];
  const cost = currentBasis ?? held;
  const post = postWeights ?? [70, 30];
  const destination = value => ({ voo: 0, qld: 1, redirect: 'split' })[value] ?? value;
  return {
    ...rest,
    benchFee: feeV,
    benchDiv: divV,
    ccDividend: destination(jepqDividendDestination ?? (cfg.reinvest ? 'self' : 'cash')),
    postCcDividend: destination(postJepqDividend ?? 'split'),
    etfs: [
      { ticker: 'VOO', kind: 'core', under: 'sp', beta: 1, lev: 1, freq: 4, fee: feeV, div: divV, holding: held[0], basis: cost[0], weight: weights[0], postWeight: post[0] },
      { ticker: 'QLD', kind: 'core', under: 'ndx', beta: 1, lev: 2, freq: 4, fee: feeQ, div: divQ, holding: held[1], basis: cost[1], weight: weights[1], postWeight: post[1] },
      { ticker: 'JEPQ', kind: 'cc', under: 'ndx', beta: betaJ, alpha: alphaJ, fee: feeJ, div: divJ, holding: held[2], basis: cost[2], weight: weights[2], postWeight: 0 },
    ],
  };
}

function run(overrides = {}) {
  completed = undefined;
  sandbox.simulate(toEngineConfig({ ...base, ...overrides }));
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
// Existing holdings are independent from all new contributions, including a lump sum.
const held = run({ currentHoldings: [200, 300, 500], currentBasis: [150, 330, 400], initial: 100, monthly: 10, weights: [100, 0, 0] });
close(held.startValue, 1100);
close(held.startBasis, 980);
close(held.investedTotal, 1220);
close(held.assetVals[0], 420);
close(held.assetVals[1], 300);
close(held.assetVals[2], 500);
close(held.assetBasis[0], 370);
close(held.assetBasis[1], 330);
close(held.assetBasis[2], 400);
close(held.twr[0], 0);
close(held.mdd[0], 0);
// Replacing the contribution allocation must not replace the starting holdings.
const shifted = run({ currentHoldings: [200, 300, 500], initial: 100, monthly: 10, weights: [0, 100, 0] });
close(shifted.assetVals[0], 200);
close(shifted.assetVals[1], 520);
close(shifted.assetVals[2], 500);
close(shifted.finGross[0], held.finGross[0]);
// No new money is required when existing holdings have value. Preserve their basis.
const oldGain = run({ currentHoldings: [1400, 0, 0], currentBasis: [1000, 0, 0], initial: 0, monthly: 0, cgTax: 22 });
close(oldGain.startValue, 1400);
close(oldGain.taxTotal[0], 33);
close(oldGain.finNet[0], 1367);
close(oldGain.paths[0], 1367);
close(oldGain.twr[0], 0);
close(oldGain.benchFinNet[0], oldGain.finNet[0]);
const oldLoss = run({ currentHoldings: [700, 0, 0], currentBasis: [1000, 0, 0], initial: 0, monthly: 0, cgTax: 22 });
close(oldLoss.taxTotal[0], 0);
close(oldLoss.assetBasis[0], 1000);
const unspecifiedBasis = run({ currentHoldings: [200, 300, 500], initial: 0, monthly: 0 });
assert.deepEqual(Array.from(unspecifiedBasis.assetBasis.slice(0, 3)), [200, 300, 500]);
// A zero acquisition cost is explicit, not treated as a missing value.
const zeroBasis = run({ currentHoldings: [1400, 0, 0], currentBasis: [0, 0, 0], initial: 0, monthly: 0, cgTax: 22 });
close(zeroBasis.taxTotal[0], 253);
// Existing JEPQ alone can trigger the strategy even if new deposits never buy it.
const heldJepqSwitch = run({ currentHoldings: [0, 0, 200], initial: 0, monthly: 100, weights: [100, 0, 0], divJ: 12, strategyMode: 'dividend', dividendTarget: 2, postWeights: [0, 100] });
assert.equal(heldJepqSwitch.switchMonths[0], 1);
close(heldJepqSwitch.annualInvestments[0], 100);
close(heldJepqSwitch.annualInvestments[1], 1100);
close(heldJepqSwitch.annualInvestments[2], 0);
close(heldJepqSwitch.assetBasis[2], 200);
assert.throws(() => run({ currentHoldings: [-1, 0, 0] }), /Invalid initial/);
assert.throws(() => run({ currentHoldings: [0, 0, 0], currentBasis: [10, 0, 0] }), /requires a holding/);

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
const qldTwoDay = (1 + sandbox.etfDailyReturn(0.10, 1, 2, 0, 0))
  * (1 + sandbox.etfDailyReturn(-0.090909090909, 1, 2, 0, 0)) - 1;
close(qldTwoDay, -0.0181818181816, 1e-10);

// One formula covers the plain index fund and daily-reset leverage; borrowing is charged on the levered part only.
close(sandbox.etfDailyReturn(0.01, 1, 2, 0.0001, 0.0002), 0.02 - 0.0001 - 0.0002, 1e-15);
close(sandbox.etfDailyReturn(0.01, 1, 1, 0.0001, 0.0002), 0.0099, 1e-15);
close(sandbox.etfDailyReturn(0.01, 0.8, 3, 0, 0.001), 0.024 - 0.002, 1e-15);

// A chosen broad-market crash is injected in the requested month on every path.
const stressedVOO = run({ monthly: 0, initial: 1000, stressMonth: 6, stressDrop: 50 });
close(stressedVOO.finGross[0], 500, 1e-6);
close(stressedVOO.benchFinGross[0], 500, 1e-6);
close(stressedVOO.paths[6], 500, 1e-4);
close(stressedVOO.mdd[0], -0.5, 1e-6);
assert.equal(Math.ceil(stressedVOO.mddAt[0] / 21), 6);
const stressedQLD = run({ monthly: 0, initial: 1000, weights: [0, 100, 0], stressMonth: 6, stressDrop: 50 });
assert.ok(stressedQLD.finGross[0] > 0 && stressedQLD.finGross[0] < 500, 'QLD must amplify the injected index crash through daily 2x returns');

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
close(dividend.assetBasis[0], 1000 + dividend.dividendReinvested[0]);
assert.ok(dividend.dividendReinvested[0] > 0);

// JEPQ's annual fee must be divided by trading days once, not twice.
const jepqFee = run({ monthly: 0, initial: 1000, weights: [0, 0, 100], feeJ: 0.35 });
close(jepqFee.finGross[0], 1000 * (1 - 0.0035 / 12) ** 12, 1e-6);
const uncappedJepq = run({ years: 1 / 12, monthly: 0, initial: 1000, weights: [0, 0, 100], muQ: (1.1 ** 12 - 1) * 100, betaJ: 1, divJ: 0, feeJ: 0, alphaJ: 0 });
close(uncappedJepq.finGross[0], 1100, 1e-6);

// JEPQ dividends can be routed independently after withholding.
const routedVOO = run({ monthly: 0, initial: 1000, weights: [0, 0, 100], divJ: 12, jepqDividendDestination: 'voo' });
close(routedVOO.assetVals[2], 1000 * 0.99 ** 12);
close(routedVOO.assetVals[0], 1000 * (1 - 0.99 ** 12));
close(routedVOO.dividendReinvested[0], routedVOO.assetVals[0]);
close(routedVOO.cash[0], 0);
const routedQLD = run({ monthly: 0, initial: 1000, weights: [0, 0, 100], divJ: 12, jepqDividendDestination: 'qld' });
close(routedQLD.assetVals[1], 1000 * (1 - 0.99 ** 12));
const routedSplit = run({ monthly: 0, initial: 0, currentHoldings: [0, 0, 1000], weights: [70, 30, 0], divJ: 12, jepqDividendDestination: 'split' });
close(routedSplit.assetVals[0], 700 * (1 - 0.99 ** 12));
close(routedSplit.assetVals[1], 300 * (1 - 0.99 ** 12));
const routedCash = run({ monthly: 0, initial: 1000, weights: [0, 0, 100], divJ: 12, jepqDividendDestination: 'cash' });
close(routedCash.cash[0], 1000 * (1 - 0.99 ** 12));
close(routedCash.dividendReinvested[0] + routedCash.dividendReinvested[1] + routedCash.dividendReinvested[2], 0);
const withheld154 = run({ years: 1 / 12, monthly: 0, initial: 1000, weights: [0, 0, 100], divJ: 12, whTax: 15.4, jepqDividendDestination: 'cash' });
close(withheld154.cash[0], 8.46);
close(withheld154.finGross[0], 998.46);

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

// With no switch, retain the original model exactly, including the random path.
const noSwitch = run({ strategyMode: 'none', postWeights: [0, 0] });
assert.deepEqual(Array.from(noSwitch.paths), Array.from(flat.paths));
assert.ok(Array.from(noSwitch.switchMonths).every(month => month === -1));

// Zero market return: net JEPQ payout is 1 in month 1 and 2 in month 2.
// Month 2's payout is redirected immediately; new deposits change in month 3.
const transitionConfig = {
  initial: 0, monthly: 100, weights: [0, 0, 100], divJ: 12,
  strategyMode: 'dividend', dividendTarget: 2, postWeights: [70, 30],
  postJepqDividend: 'split',
};
const transitioned = run(transitionConfig);
for (let i = 0; i < transitioned.N; i += 1) {
  assert.equal(transitioned.switchMonths[i], 2);
  close(transitioned.switchDividends[i], 2);
  close(transitioned.finGross[i], 1200);
  close(transitioned.twr[i], 0);
  close(transitioned.assetVals[i * 3 + 2], 200 * 0.99 ** 11);
  close(transitioned.assetBasis[i * 3 + 2], 201);
  close(transitioned.dividendReinvested[i * 3 + 2], 1);
  const reinvestedTotal=transitioned.dividendReinvested[i*3]+transitioned.dividendReinvested[i*3+1]+transitioned.dividendReinvested[i*3+2];
  const dividendsTotal=transitioned.annualDivs[i*3]+transitioned.annualDivs[i*3+1]+transitioned.annualDivs[i*3+2];
  close(reinvestedTotal,dividendsTotal,1e-5);
  close(transitioned.cash[i], 0);
  close(transitioned.annualInvestments[i * 3], 700);
  close(transitioned.annualInvestments[i * 3 + 1], 300);
  close(transitioned.annualInvestments[i * 3 + 2], 200);
}

// Even if payouts subsequently fall below the target, switching is irreversible.
const stoppedContributions = run({ ...transitionConfig, initial: 200, monthly: 0 });
assert.equal(stoppedContributions.switchMonths[0], 1);
close(stoppedContributions.assetVals[2], 200 * 0.99 ** 12);
close(stoppedContributions.assetBasis[2], 200);

// Cash policy keeps JEPQ payouts out of all ETFs; conservation and basis still hold.
const cashTransition = run({ ...transitionConfig, postJepqDividend: 'cash' });
close(cashTransition.finGross[0], 1200);
close(cashTransition.assetVals[2], transitioned.assetVals[2]);
close(cashTransition.assetBasis[2], 201);
close(cashTransition.assetBasis[0], 700);
close(cashTransition.assetBasis[1], 300);
close(cashTransition.cash[0], 200 - 200 * 0.99 ** 11);
close(cashTransition.dividendReinvested[2], 1);
const vooTransition = run({ ...transitionConfig, postJepqDividend: 'voo' });
close(vooTransition.dividendReinvested[0], 200 - 200 * 0.99 ** 11);
close(vooTransition.dividendReinvested[1], 0);
const qldTransition = run({ ...transitionConfig, postJepqDividend: 'qld' });
close(qldTransition.dividendReinvested[0], 0);
close(qldTransition.dividendReinvested[1], 200 - 200 * 0.99 ** 11);
const previousCash = run({ ...transitionConfig, reinvest: false });
assert.equal(previousCash.switchMonths[0], 3);
close(previousCash.cash[0], 2.99);
close(previousCash.finGross[0], 1200);

// The trigger uses actual net payout, not gross, cumulative, or a forward estimate.
const netTrigger = run({ ...transitionConfig, whTax: 50, dividendTarget: 1 });
assert.equal(netTrigger.switchMonths[0], 3);
close(netTrigger.switchDividends[0], 1.4925125);
assert.equal(run({ ...transitionConfig, whTax: 100 }).switchMonths[0], -1);
assert.equal(run({ ...transitionConfig, divJ: 0 }).switchMonths[0], -1);
assert.equal(run({ ...transitionConfig, weights: [100, 0, 0] }).switchMonths[0], -1);
assert.equal(run({ ...transitionConfig, dividendTarget: 9999 }).switchMonths[0], -1);

// A time-based switch at year 1 leaves year-1 contributions in the old allocation.
const timed = run({ ...transitionConfig, strategyMode: 'month', switchAfterMonths: 12, years: 2 });
assert.equal(timed.switchMonths[0], 12);
close(timed.annualInvestments[2], 1200);
close(timed.annualInvestments[3], 840);
close(timed.annualInvestments[4], 360);
close(timed.annualInvestments[5], 0);
const atEnd = run({ ...transitionConfig, strategyMode: 'month', switchAfterMonths: 12 });
assert.equal(atEnd.switchMonths[0], 12);
close(atEnd.annualInvestments[2], 1200);
const tooLate = run({ ...transitionConfig, strategyMode: 'month', switchAfterMonths: 13 });
assert.equal(tooLate.switchMonths[0], -1);

// A switch protects JEPQ from annual rebalancing and tax funding sales.
const rebalanced = run({ ...transitionConfig, rebal: true });
close(rebalanced.assetVals[2], transitioned.assetVals[2]);
close(rebalanced.assetBasis[2], transitioned.assetBasis[2]);
const protectedState = sandbox.makeState([80, 20, 100]);
protectedState.protected = [false, false, true];
sandbox.rebalanceState(protectedState, [0.7, 0.3, 0], [0, 1]);
close(protectedState.h[0], 70);
close(protectedState.h[1], 30);
close(protectedState.h[2], 100);
sandbox.payPortfolioCost(protectedState, 10);
close(protectedState.h[2], 100);
close(protectedState.basis[2], 100);
close(sandbox.totalValue(protectedState), 190);

// Policy changes must not consume randomness or alter the paired benchmark.
const stochasticConfig = {
  ...transitionConfig, years: 2, sims: 8, muQ: 11, volQ: 22, muS: 9, volS: 16,
  fxOn: true, fxVol: 10, whTax: 15, cgTax: 22, divV: 1.3, divQ: 0.3,
};
const stochasticFixed = run({ ...stochasticConfig, strategyMode: 'none' });
const stochasticSwitch = run({ ...stochasticConfig, strategyMode: 'month', switchAfterMonths: 8 });
assert.deepEqual(Array.from(stochasticSwitch.benchPaths), Array.from(stochasticFixed.benchPaths));
assert.deepEqual(Array.from(stochasticSwitch.benchFinNet), Array.from(stochasticFixed.benchFinNet));
for (let i = 0; i < stochasticSwitch.N; i += 1) {
  for (let m = 0; m < 8; m += 1) {
    close(stochasticSwitch.paths[i * 25 + m], stochasticFixed.paths[i * 25 + m]);
  }
}
const repeatSwitch = run({ ...stochasticConfig, strategyMode: 'month', switchAfterMonths: 8 });
assert.deepEqual(Array.from(stochasticSwitch.paths), Array.from(repeatSwitch.paths));
assert.deepEqual(Array.from(stochasticSwitch.switchMonths), Array.from(repeatSwitch.switchMonths));

assert.throws(() => run({ ...transitionConfig, postWeights: [0, 0] }), /allocation/);
assert.throws(() => run({ ...transitionConfig, dividendTarget: 0 }), /target/);
assert.throws(() => run({ ...transitionConfig, strategyMode: 'month', switchAfterMonths: 1.5 }), /month/);

// --- Any number of ETFs ---------------------------------------------------------
const quiet = {
  monthly: 0, initial: 0, years: 1, growth: 0, inflation: 0, reinvest: true, rebal: false, sims: 2, fxOn: false,
  muQ: 0, volQ: 0, muS: 0, volS: 0, rho: 0, borrow: 0, fxMu: 0, fxVol: 0, fxCorr: 0, whTax: 0, cgTax: 0, deduction: 250, seed: 'multi',
};
const etf = (ticker, extra = {}) => ({ ticker, kind: 'core', under: 'sp', beta: 1, lev: 1, freq: 4, fee: 0, div: 0, alpha: 0, holding: 0, weight: 0, postWeight: 0, ...extra });
const coveredCall = (ticker, extra = {}) => etf(ticker, { kind: 'cc', under: 'ndx', beta: 0.8, div: 12, ...extra });
function runEtfs(etfs, overrides = {}) {
  completed = undefined;
  sandbox.simulate({ ...quiet, ...overrides, etfs });
  assert.ok(completed, 'simulation did not return a result');
  return completed;
}

// A single ETF is a valid portfolio.
const solo = runEtfs([etf('VOO', { weight: 100 })], { initial: 1000 });
assert.equal(solo.n, 1);
close(solo.finGross[0], 1000);

// Five ETFs: new money follows the weights; an ETF that is only held keeps its value and basis.
const five = runEtfs([
  etf('A', { weight: 40 }), etf('B', { weight: 30, under: 'ndx' }), etf('C', { weight: 20 }), etf('D', { weight: 10 }),
  etf('HELD', { holding: 500, basis: 300 }),
], { monthly: 10 });
assert.equal(five.n, 5);
assert.deepEqual(Array.from(five.assetVals.slice(0, 5)).map(v => Math.round(v * 1e6) / 1e6), [48, 36, 24, 12, 500]);
close(five.assetBasis[4], 300);
close(five.startValue, 500);
close(five.investedTotal, 620);
close(five.annualInvestments[4], 0);

// Leverage is per ETF: 3x falls further than 2x in the same injected crash.
const crash = { initial: 1000, stressMonth: 6, stressDrop: 50 };
const twoX = runEtfs([etf('L2', { under: 'ndx', lev: 2, weight: 100 })], crash);
const threeX = runEtfs([etf('L3', { under: 'ndx', lev: 3, weight: 100 })], crash);
assert.ok(threeX.finGross[0] > 0 && threeX.finGross[0] < twoX.finGross[0]);
// A sensitivity of 0.5 halves each daily index move.
const halfBeta = runEtfs([etf('H', { beta: 0.5, weight: 100 })], { initial: 1000, muS: 21 });
close(halfBeta.finGross[0], 1000 * (1 + 0.5 * (1.21 ** (1 / 252) - 1)) ** 252, 1e-6);

// Payout frequency is per ETF: a monthly payer loses withholding twelve times a year.
const monthlyPayer = runEtfs([etf('M', { div: 12, freq: 12, weight: 100 })], { initial: 1000, whTax: 15 });
close(monthlyPayer.finGross[0], 1000 * (1 - 0.01 * 0.15) ** 12, 1e-6);

// Two covered-call ETFs: the dividend trigger uses their combined net payout (1 + 1 in month 1).
const twoCc = runEtfs([etf('VOO', { postWeight: 100 }), coveredCall('J1', { weight: 50 }), coveredCall('J2', { weight: 50 })],
  { monthly: 200, ccDividend: 'self', strategyMode: 'dividend', dividendTarget: 2, postCcDividend: 'split' });
assert.equal(twoCc.switchMonths[0], 1);
close(twoCc.switchDividends[0], 2);
close(twoCc.annualInvestments[0], 2200);
close(twoCc.annualInvestments[1], 100);
close(twoCc.annualInvestments[2], 100);
close(twoCc.assetVals[1], 100 * 0.99 ** 12);
close(twoCc.assetVals[2], 100 * 0.99 ** 12);
close(twoCc.finGross[0], 2400);
// One of them alone pays only 1 in month 1, so it switches a month later.
const oneCc = runEtfs([etf('VOO', { postWeight: 100 }), coveredCall('J1', { weight: 100 })],
  { monthly: 100, ccDividend: 'self', strategyMode: 'dividend', dividendTarget: 2, postCcDividend: 'split' });
assert.equal(oneCc.switchMonths[0], 2);

// Covered-call payouts can go to any one ordinary ETF, or be split by the ordinary ETFs' weights only.
const toSecond = runEtfs([etf('VOO'), etf('QQQ', { under: 'ndx' }), coveredCall('J', { weight: 100 })], { initial: 1000, ccDividend: 1 });
close(toSecond.assetVals[0], 0);
close(toSecond.assetVals[1], 1000 * (1 - 0.99 ** 12));
const splitCore = runEtfs([etf('A', { weight: 30 }), etf('B', { weight: 10 }), coveredCall('J', { weight: 60, holding: 1000 })], { ccDividend: 'split' });
close(splitCore.assetVals[0], 0.75 * 1000 * (1 - 0.99 ** 12));
close(splitCore.assetVals[1], 0.25 * 1000 * (1 - 0.99 ** 12));
assert.throws(() => runEtfs([etf('A', { weight: 100 }), coveredCall('J')], { ccDividend: 1 }), /destination/);
assert.throws(() => runEtfs([coveredCall('J', { weight: 100 })], { initial: 100, ccDividend: 'split' }), /required/);
// Without a covered-call ETF the payout routing is irrelevant.
close(runEtfs([etf('A', { weight: 100 })], { initial: 100, ccDividend: 'split' }).finGross[0], 100);

// Annual rebalancing moves an ETF that is only held into the contribution weights.
const soldHeld = runEtfs([etf('A', { weight: 100 }), etf('H', { holding: 500 })], { rebal: true });
close(soldHeld.assetVals[0], 500);
close(soldHeld.assetVals[1], 0);

assert.throws(() => runEtfs([]), /ETF list/);
assert.throws(() => runEtfs([etf('A')], { initial: 100 }), /allocation/);
assert.throws(() => runEtfs([etf('A', { weight: 100, under: 'dow' })]), /ETF model/);
assert.throws(() => runEtfs([etf('A', { weight: 100, kind: 'bond' })]), /ETF kind/);

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
  alphaJ: 7,
  fxMu: 0,
  fxVol: 10,
  fxCorr: -0.25,
  whTax: 15,
  cgTax: 22,
  deduction: 250,
  seed: '20260916',
  strategyMode: 'dividend', dividendTarget: 100, postWeights: [70, 30], postJepqDividend: 'split',
});
for (let i = 0; i < smoke.N; i += 1) {
  assert.ok(Number.isFinite(smoke.finNet[i]) && smoke.finNet[i] >= 0);
  assert.ok(Number.isFinite(smoke.twr[i]));
  assert.ok(smoke.mdd[i] <= 0 && smoke.mdd[i] >= -1);
  assert.ok(Number.isFinite(smoke.taxTotal[i]) && smoke.taxTotal[i] >= 0);
  assert.ok(smoke.switchMonths[i] === -1 || (smoke.switchMonths[i] >= 1 && smoke.switchMonths[i] <= smoke.months));
  if (smoke.switchMonths[i] > 0) assert.ok(smoke.switchDividends[i] >= 100);
  close(Array.from(smoke.annualInvestments.slice(i * 15 * 3, (i + 1) * 15 * 3)).reduce((a, b) => a + b, 0), 18000);
}

console.log('model core tests passed');
