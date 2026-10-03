const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Lightweight source-level UI integration checks; no browser or external libraries.
const html = fs.readFileSync('dca_model.html', 'utf8');
const main = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
new vm.Script(main);
const workerMarker = '<script type="text/plain" id="simulation-worker">';
const workerStart = html.indexOf(workerMarker) + workerMarker.length;
const workerSource = html.slice(workerStart, html.indexOf('</script>', workerStart));
assert.match(html, /현재 전략 · \$\{rank\} 종료경로/);
assert.match(html, /같은 경로의 VOO 100%/);
assert.match(html, /강제 폭락 시점/);
assert.match(html, /그래프에 표시할 실제 경로/);
assert.match(main, /r\.paths\[selected\*cols\+m\]/);
assert.match(main, /r\.benchPaths\[selected\*cols\+m\]/);
let result;
const worker = { self: { postMessage: m => { if (m.type === 'done') result = m.result; } } };
vm.createContext(worker);
vm.runInContext(workerSource, worker);

const elements = new Map();
function classes() {
  const set = new Set();
  return { add: name => set.add(name), remove: name => set.delete(name), contains: name => set.has(name), toggle: (name, on) => on ? set.add(name) : set.delete(name) };
}
const stub = (tag, attrs = '') => ({
  tag, value: attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? '',
  checked: /\bchecked\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs), hidden: /\bhidden\b/.test(attrs),
  textContent: '', innerHTML: '', className: '', style: {}, dataset: {}, classList: classes(),
  setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, scrollIntoView() {},
});
for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
  const [, tag, attrs, id] = match;
  assert.ok(!elements.has(id), `Duplicate element ID: ${id}`);
  elements.set(id, stub(tag, attrs));
}
for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const opts = [...match[2].matchAll(/<option\b([^>]*)>/g)];
  const selected = opts.find(o => /\bselected\b/.test(o[1])) ?? opts[0];
  elements.get(match[1]).value = selected[1].match(/value="([^"]*)"/)[1];
}
// The rows for each ETF are rendered at runtime, so their elements exist only once the page asks for them.
const runtimeId = /^(pt|pl|ps|pi|w|cmpl|cmp|ht|hl|hs|hi|hv|hb)-r\d+$|^p-[A-Z0-9.-]+-(kind|under|beta|lev|alpha|fee|div|freq)$|^pw-[A-Z0-9.-]+$/;
const element = id => {
  if (!elements.has(id) && runtimeId.test(id)) elements.set(id, stub('input'));
  assert.ok(elements.has(id), `Missing element: ${id}`);
  return elements.get(id);
};
element('configForm').querySelectorAll = () => [...elements.values()].filter(e => e.tag === 'input');
const ui = {
  document: { getElementById: element, querySelectorAll: () => [], body: { classList: classes() }, documentElement: {}, activeElement: null },
  matchMedia: () => ({ matches: true }),
};
vm.createContext(ui);
const startup = 'renderEtfLists();updateStressControls();runSimulation({initial:true});';
assert.ok(main.includes(startup));
vm.runInContext(main.replace(startup, 'renderEtfLists();updateStressControls();'), ui);
const set = (id, value) => { element(id).value = String(value); };
const state = code => vm.runInContext(code, ui);
const tickers = cfg => Array.from(cfg.etfs, e => e.ticker);
const column = (cfg, key) => Array.from(cfg.etfs, e => e[key]);
const messages = () => Array.from(ui.validate(ui.getConfig()));

// Default scenario: VOO/QLD/JEPQ and a 100만원 net-dividend trigger; after it, new money keeps the VOO:QLD ratio.
const defaults = ui.getConfig();
assert.deepEqual(tickers(defaults), ['VOO', 'QLD', 'JEPQ']);
assert.deepEqual(column(defaults, 'kind'), ['core', 'core', 'cc']);
assert.deepEqual(column(defaults, 'weight'), [50, 20, 30]);
assert.deepEqual(column(defaults, 'postWeight'), [50, 20, 0]);
assert.equal(element('postWeights').hidden, true);
assert.deepEqual(column(defaults, 'holding'), [0, 0, 0]);
assert.deepEqual(column(defaults, 'lev'), [1, 2, 1]);
assert.equal(defaults.strategyMode, 'dividend');
assert.equal(defaults.dividendTarget, 100);
assert.equal(defaults.ccDividend, 'split');
assert.equal(defaults.postCcDividend, 'split');
assert.equal(defaults.whTax, 15);
assert.equal(defaults.muQ, 13);
assert.equal(defaults.volQ, 23);
assert.equal(defaults.borrow, 3.5);
assert.equal(defaults.marketPreset, 'balanced');
assert.equal(defaults.stressMonth, 90);
assert.equal(defaults.stressDrop, 0);
assert.equal(element('marketPreset').value, 'balanced');
assert.equal(element('pathPercentile').value, '0.5');
assert.match(element('qldGrowthHint').textContent, /QLD 연 9\.9%/);
assert.match(element('qldGrowthHint').textContent, /VOO 연 7\.6%/);
assert.equal(ui.validate(defaults).length, 0);
assert.equal(element('dividendTriggerField').hidden, false);
assert.equal(element('monthTriggerField').hidden, true);
ui.applyMarketPreset('conservative');
assert.equal(ui.getConfig().muQ, 11);
assert.equal(ui.getConfig().volQ, 22);
assert.equal(ui.getConfig().borrow, 4);
assert.match(element('qldGrowthHint').textContent, /QLD 연 6\.4%/);
ui.applyMarketPreset('balanced');
// The page starts with one removable row per planned ETF and no holdings; labels name the chosen ETFs.
assert.equal((element('planList').innerHTML.match(/data-remove="plan"/g) ?? []).length, 3);
assert.equal(element('holdingList').innerHTML, '');
assert.equal(element('ccDividendLabel').textContent, 'JEPQ 세후배당 사용처');
assert.match(element('ccDividend').innerHTML, /VOO·QLD에 투자 비중대로/);
assert.equal(element('ccDividendField').hidden, false);
// What the form produces is what the engine accepts.
worker.simulate({ ...defaults, sims: 2, years: 1 });
assert.equal(result.n, 3);

// Holdings are their own list: an ETF can be held without being bought going forward.
const heldVoo = ui.addRow('holdings', 'VOO');
const heldSchd = ui.addRow('holdings', 'SCHD');
const heldJepq = ui.addRow('holdings', 'JEPQ');
heldVoo.value = '200';
heldSchd.value = '300';
heldJepq.value = '500';
heldJepq.basis = '400';
set('monthly', 0);
set('initial', 0);
const holdingConfig = ui.getConfig();
assert.deepEqual(tickers(holdingConfig), ['VOO', 'QLD', 'JEPQ', 'SCHD']);
assert.deepEqual(column(holdingConfig, 'holding'), [200, 0, 500, 300]);
assert.deepEqual(column(holdingConfig, 'basis'), [200, 0, 400, 300]);
assert.deepEqual(column(holdingConfig, 'weight'), [50, 20, 30, 0]);
assert.equal(ui.validate(holdingConfig).length, 0);
ui.updateAllocation();
assert.match(element('holdingsSummary').textContent, /1,000만원/);
assert.match(element('holdingsSummary').textContent, /JEPQ 50.0%/);
assert.equal((element('holdingList').innerHTML.match(/data-remove="holdings"/g) ?? []).length, 3);
worker.simulate({ ...holdingConfig, sims: 2, years: 1 });
assert.equal(result.n, 4);
assert.equal(result.startValue, 1000);
assert.equal(result.startBasis, 900);
// Everything below the lists follows them: an ETF that is only held can still receive covered-call payouts.
assert.equal(element('reinvestLabel').textContent, 'VOO·QLD·SCHD 배당금');
assert.match(element('ccDividend').innerHTML, /value="etf:SCHD"/);
assert.match(element('postCcDividend').innerHTML, /value="etf:SCHD"/);
set('ccDividend', 'etf:SCHD');
assert.equal(ui.getConfig().ccDividend, 3);
worker.simulate({ ...ui.getConfig(), sims: 2, years: 1 });
assert.ok(result.dividendReinvested[3] > 0);
set('ccDividend', 'split');
// Dropping the planned weight does not touch what is held.
state("plan[2].weight='0'");
assert.deepEqual(column(ui.getConfig(), 'holding'), [200, 0, 500, 300]);
heldJepq.basis = '0';
assert.equal(ui.getConfig().etfs[2].basis, 0);
heldJepq.value = '-1';
assert.ok(messages().length > 0);
heldJepq.value = '0';
heldJepq.basis = '100';
assert.ok(messages().length > 0);
heldJepq.basis = '';
assert.equal(messages().length, 0);
// Removing a holding row drops an ETF that was only held.
ui.removeRow('holdings', heldSchd.id);
assert.deepEqual(tickers(ui.getConfig()), ['VOO', 'QLD', 'JEPQ']);
ui.removeRow('holdings', heldVoo.id);
ui.removeRow('holdings', heldJepq.id);
assert.equal(element('holdingList').innerHTML, '');
set('monthly', 100);
state("plan[2].weight='30'");

// A ticker can be swapped in place: its assumptions and every label follow, the row's weights stay.
const rows = state('plan');
assert.equal(ui.setRowTicker('plan', rows[1].id, ' tqqq '), true);
assert.equal(ui.getConfig().etfs[1].ticker, 'TQQQ');
assert.equal(ui.getConfig().etfs[1].lev, 3);
assert.equal(ui.getConfig().etfs[1].weight, 20);
assert.equal(ui.getConfig().etfs[1].postWeight, 20);
assert.match(element('qldGrowthHint').textContent, /TQQQ 연/);
assert.match(element(`pi-${rows[1].id}`).innerHTML, /나스닥100 일간 3배/);
assert.match(element('ccDividend').innerHTML, /VOO·TQQQ에 투자 비중대로/);
assert.equal(ui.setRowTicker('plan', rows[1].id, 'VOO'), false);
assert.match(element('planNote').textContent, /이미 목록에 있는 ETF/);
assert.equal(ui.getConfig().etfs[1].ticker, 'TQQQ');
// An unlisted ticker is accepted with editable defaults.
assert.equal(ui.setRowTicker('plan', rows[1].id, 'zzzz'), true);
assert.equal(element('planNote').textContent, '');
assert.equal(ui.getConfig().etfs[1].kind, 'core');
assert.match(element(`pi-${rows[1].id}`).innerHTML, /목록에 없는 ETF/);
assert.match(element('etfParams').innerHTML, /id="p-ZZZZ-fee"/);
assert.equal(messages().length, 0);
ui.syncDynamicField({ value: '', dataset: { ticker: 'ZZZZ', param: 'fee' } });
assert.ok(messages().length > 0);
ui.syncDynamicField({ value: '0.5', dataset: { ticker: 'ZZZZ', param: 'fee' } });
assert.equal(ui.getConfig().etfs[1].fee, 0.5);
assert.equal(ui.setRowTicker('plan', rows[1].id, 'QLD'), true);
// Another covered-call ETF takes over the covered-call role.
assert.equal(ui.setRowTicker('plan', rows[2].id, 'QQQI'), true);
assert.equal(ui.getConfig().etfs[2].kind, 'cc');
assert.equal(ui.getConfig().etfs[2].div, 14);
assert.equal(element('ccDividendLabel').textContent, 'QQQI 세후배당 사용처');
assert.equal(element('dividendTargetLabel').textContent, 'QQQI 월 세후배당 목표');
assert.equal(ui.setRowTicker('plan', rows[2].id, 'JEPQ'), true);

// ETFs can be added up to eight in total, and the planned list always keeps at least one.
const added = ui.addRow('plan');
assert.equal(added.ticker, 'QQQ');
assert.equal(added.weight, '0');
added.weight = '10';
assert.deepEqual(tickers(ui.getConfig()), ['VOO', 'QLD', 'JEPQ', 'QQQ']);
assert.equal(messages().length, 0);
ui.updateAllocation();
assert.match(element('allocMsg').textContent, /입력 합계 110%/);
for (const ticker of ['SCHD', 'SPY', 'VTI', 'IVV']) assert.ok(ui.addRow('plan', ticker));
assert.equal(state('plan.length'), 8);
assert.equal(ui.addRow('plan'), null);
assert.equal(element('addPlan').disabled, true);
assert.equal(ui.setRowTicker('plan', added.id, 'SMH'), true);
const heldAtCap = ui.addRow('holdings');
assert.equal(heldAtCap.ticker, 'VOO');
assert.equal(ui.setRowTicker('holdings', heldAtCap.id, 'XLK'), false);
assert.match(element('holdingNote').textContent, /8종까지/);
worker.simulate({ ...ui.getConfig(), sims: 2, years: 1 });
assert.equal(result.n, 8);
ui.resetEtfState();
ui.renderEtfLists();
assert.deepEqual(tickers(ui.getConfig()), ['VOO', 'QLD', 'JEPQ']);
assert.equal(element('addPlan').disabled, false);
for (const row of Array.from(state('plan'))) ui.removeRow('plan', row.id);
assert.equal(state('plan.length'), 1);
assert.deepEqual(tickers(ui.getConfig()), ['JEPQ']);
// Only a covered-call ETF is left: payouts fall back to reinvesting, and a switch has nowhere to send new money.
assert.equal(element('ccDividend').value, 'self');
assert.doesNotMatch(element('ccDividend').innerHTML, /value="split"/);
assert.match(messages().join('\n'), /일반 ETF가 없어/);
ui.resetEtfState();
ui.renderEtfLists();
set('ccDividend', 'split');

// Without a covered-call ETF the dividend trigger switches itself off, and returns with the next covered-call ETF.
ui.removeRow('plan', state('plan[2].id'));
assert.equal(element('ccDividendField').hidden, true);
assert.equal(element('strategyMode').value, 'none');
assert.equal(element('strategyNote').hidden, false);
assert.equal(element('strategyDividendOption').disabled, true);
assert.equal(messages().length, 0);
const returned = ui.addRow('plan', 'QQQI');
assert.equal(element('strategyMode').value, 'dividend');
assert.equal(element('strategyNote').hidden, true);
assert.equal(element('dividendTargetLabel').textContent, 'QQQI 월 세후배당 목표');
ui.removeRow('plan', returned.id);
assert.equal(element('strategyMode').value, 'none');
// A timed switch still works without one.
set('strategyMode', 'month');
ui.updateStrategyControls();
assert.equal(messages().length, 0);
worker.simulate({ ...ui.getConfig(), sims: 2, years: 11 });
assert.equal(result.switchMonths[0], 120);
ui.resetEtfState();
ui.renderEtfLists();

assert.equal(element('dividendTarget').disabled, true);
assert.equal(element('switchAfterMonths').disabled, false);
set('dividendTarget', ''); // Inactive controls must not block validation.
assert.equal(messages().length, 0);
set('switchAfterMonths', 1.5);
assert.ok(messages().length > 0);
set('switchAfterMonths', 480);
ui.updateStrategyControls();
assert.match(element('triggerHelp').textContent, /전환되지 않습니다/);

// Post-switch weights follow the planned weights until the user chooses to type their own.
set('strategyMode', 'dividend');
set('dividendTarget', 100);
ui.updateStrategyControls();
assert.match(element('postAllocation').textContent, /VOO 71\.4% · QLD 28\.6% · JEPQ 0%/);
state("plan[0].weight='10'");
ui.updateAllocation();
assert.match(element('postAllocation').textContent, /VOO 33\.3% · QLD 66\.7% · JEPQ 0%/);
state("plan[0].weight='50'");
set('postMode', 'manual');
ui.refreshEtfUi();
assert.equal(element('postWeights').hidden, false);
assert.match(element('postWeights').innerHTML, /id="pw-VOO"[^>]*value="71.4"/);
assert.match(element('postWeights').innerHTML, /id="pw-QLD"[^>]*value="28.6"/);
assert.doesNotMatch(element('postWeights').innerHTML, /pw-JEPQ/);
const typePost = (ticker, value) => ui.syncDynamicField({ value, dataset: { post: ticker } });
typePost('VOO', '');
typePost('QLD', '');
set('strategyMode', 'none');
ui.updateStrategyControls();
assert.equal(element('strategyControls').hidden, true);
assert.equal(messages().length, 0);
set('strategyMode', 'dividend');
assert.ok(messages().length > 0);
typePost('VOO', '70');
typePost('QLD', '30');
ui.updateStrategyControls();
assert.match(element('postAllocation').textContent, /VOO 70\.0% · QLD 30\.0% · JEPQ 0%/);
assert.equal(messages().length, 0);
assert.deepEqual(column(ui.getConfig(), 'postWeight'), [70, 30, 0]);
// An ETF that is only held can be a post-switch target and a payout destination.
const heldQqq = ui.addRow('holdings', 'QQQ');
assert.match(element('postWeights').innerHTML, /id="pw-QQQ"[^>]*value="0"/);
typePost('QQQ', '50');
assert.deepEqual(column(ui.getConfig(), 'postWeight'), [70, 30, 0, 50]);
set('postCcDividend', 'etf:QQQ');
assert.equal(ui.getConfig().postCcDividend, 3);
worker.simulate({ ...ui.getConfig(), sims: 2, years: 1, dividendTarget: 0.001 });
assert.equal(result.switchMonths[0], 1);
assert.ok(result.annualInvestments[3] > 0 && result.dividendReinvested[3] > 0);
ui.removeRow('holdings', heldQqq.id);
assert.equal(element('postCcDividend').value, 'split');
set('postMode', 'auto');
ui.refreshEtfUi();
assert.equal(element('postWeights').hidden, true);
assert.deepEqual(column(ui.getConfig(), 'postWeight'), [50, 20, 0]);
assert.equal(messages().length, 0);

function render(config) {
  worker.simulate(config);
  ui.inputResult = result;
  ui.inputConfig = config;
  vm.runInContext('lastResult=inputResult;lastConfig=inputConfig;renderAll();', ui);
}
const withEtfs = (config, change) => ({ ...config, etfs: Array.from(config.etfs, e => ({ ...e, ...change(e) })) });
const cfg = withEtfs({ ...defaults, sims: 5, years: 1, initial: 0, monthly: 100, ccDividend: 'self',
  muQ: 0, volQ: 0, muS: 0, volS: 0, fxOn: false, borrow: 0, whTax: 0, cgTax: 0, dividendTarget: 2 },
  e => e.kind === 'cc' ? { weight: 100, div: 12, alpha: 0, fee: 0 } : { weight: 0, div: 0, fee: 0 });
render(cfg);
assert.equal(element('switchProbability').textContent, '100.0%');
assert.equal(element('centralSwitch').textContent, '2개월');
assert.equal(element('switchMedian').textContent, '2개월');
assert.match(element('strategyOutcomeNote').textContent, /3개월차/);
assert.match(element('strategyOutcomeNote').textContent, /기존 JEPQ는 매도하지 않고/);
assert.equal(element('strategyResultTitle').textContent, 'JEPQ 배당 목표 후 투자 전환');
assert.equal(element('strategyBefore').textContent, 'JEPQ 100.0%');
assert.equal(element('strategyAfter').textContent, 'VOO 71.4% · QLD 28.6%');
assert.match(element('conditionSummary').textContent, /신규 투자 비중 JEPQ 100 ·/);
assert.match(element('cashNote').textContent, /JEPQ 세후배당은 전환 전 같은 ETF에 재투자, 전환 후 VOO·QLD에 분할 투자합니다/);
assert.match(element('divTable').innerHTML, /2개월차 말 전환/);
assert.match(element('divTable').innerHTML, /200만원/);
assert.match(element('divTable').innerHTML, /중 커버드콜 납입액/);
for (const ticker of ['VOO', 'QLD', 'JEPQ']) assert.match(element('divTable').innerHTML, new RegExp(`>${ticker} 배당<`));
assert.match(element('scenarioTable').innerHTML, /전환 시점/);
assert.equal(element('mainMultiple').textContent, '명목 원금 대비 1.0배');
assert.match(element('assetTable').innerHTML, /누적 배당 재투자액/);
assert.match(element('assetTable').innerHTML, /과세상 미실현 손익/);

// A real-value display does not alter the nominal trigger or its timing.
vm.runInContext("viewMode='real';renderAll();", ui);
assert.equal(element('centralSwitch').textContent, '2개월');
assert.match(element('centralSwitchNote').textContent, /20,000원 · 명목/);

render({ ...cfg, dividendTarget: 9999 });
assert.equal(element('switchProbability').textContent, '0.0%');
assert.equal(element('switchMedian').textContent, '기간 내 미도달');
assert.equal(element('centralSwitch').textContent, '기간 내 미도달');
render({ ...cfg, strategyMode: 'month', switchAfterMonths: 12 });
assert.match(element('strategyOutcomeNote').textContent, /마지막 달/);
render({ ...cfg, strategyMode: 'none' });
assert.equal(element('strategyResult').hidden, true);
assert.doesNotMatch(element('scenarioTable').innerHTML, /전환 시점/);
assert.doesNotMatch(element('divTable').innerHTML, /중 커버드콜 납입액/);

// Results list every ETF, however many there are, including one that is only held.
ui.addRow('plan', 'SCHD').weight = '10';
ui.addRow('plan', 'QQQI').weight = '10';
ui.addRow('holdings', 'TQQQ').value = '100';
assert.equal(messages().length, 0);
const wide = { ...ui.getConfig(), sims: 4, years: 2 };
render(wide);
assert.equal(result.n, 6);
for (const ticker of ['VOO', 'QLD', 'JEPQ', 'SCHD', 'QQQI', 'TQQQ']) {
  assert.match(element('assetTable').innerHTML, new RegExp(`>${ticker}<`));
  assert.match(element('divTable').innerHTML, new RegExp(`>${ticker} 배당<`));
}
assert.equal(element('strategyResultTitle').textContent, 'JEPQ·QQQI 배당 목표 후 투자 전환');
assert.match(element('strategyResultDescription').textContent, /커버드콜 ETF를 합친 월 세후배당/);
assert.match(element('conditionSummary').textContent, /현재 보유 100만원/);
assert.match(element('conditionSummary').textContent, /VOO 42 \/ QLD 17 \/ JEPQ 25 \/ SCHD 8 \/ QQQI 8/);
console.log('model UI integration tests passed');
