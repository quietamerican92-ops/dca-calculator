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
for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
  const [, tag, attrs, id] = match;
  assert.ok(!elements.has(id), `Duplicate element ID: ${id}`);
  elements.set(id, {
    tag, value: attrs.match(/\bvalue="([^"]*)"/)?.[1] ?? '',
    checked: /\bchecked\b/.test(attrs), disabled: /\bdisabled\b/.test(attrs), hidden: /\bhidden\b/.test(attrs),
    textContent: '', innerHTML: '', className: '', style: {}, classList: classes(),
    setAttribute() {}, removeAttribute() {}, addEventListener() {}, focus() {}, scrollIntoView() {},
  });
}
for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const opts = [...match[2].matchAll(/<option\b([^>]*)>/g)];
  const selected = opts.find(o => /\bselected\b/.test(o[1])) ?? opts[0];
  elements.get(match[1]).value = selected[1].match(/value="([^"]*)"/)[1];
}
const element = id => { assert.ok(elements.has(id), `Missing element: ${id}`); return elements.get(id); };
element('configForm').querySelectorAll = () => [...elements.values()].filter(e => e.tag === 'input');
const ui = {
  document: { getElementById: element, querySelectorAll: () => [], body: { classList: classes() }, documentElement: {} },
  matchMedia: () => ({ matches: true }),
};
vm.createContext(ui);
vm.runInContext(main.replace('updateAllocation();updateQldGrowthHint();updateStressControls();runSimulation({initial:true});', 'updateAllocation();updateQldGrowthHint();updateStressControls();'), ui);
const set = (id, value) => { element(id).value = String(value); };

// Default scenario is the requested 100만원 net-dividend trigger, followed by 70/30.
const defaults = ui.getConfig();
assert.equal(defaults.strategyMode, 'dividend');
assert.equal(defaults.dividendTarget, 100);
assert.equal(defaults.jepqDividendDestination, 'split');
assert.equal(defaults.whTax, 15);
assert.equal(defaults.muQ, 13);
assert.equal(defaults.volQ, 23);
assert.equal(defaults.borrow, 3.5);
assert.equal(defaults.marketPreset, 'balanced');
assert.equal(defaults.stressMonth, 90);
assert.equal(defaults.stressDrop, 0);
assert.equal(element('marketPreset').value, 'balanced');
assert.equal(element('pathPercentile').value, '0.5');
assert.match(element('qldGrowthHint').textContent, /9\.9%/);
assert.deepEqual(Array.from(defaults.postWeights), [70, 30]);
assert.equal(ui.validate(defaults).length, 0);
assert.equal(element('dividendTriggerField').hidden, false);
assert.equal(element('monthTriggerField').hidden, true);
ui.applyMarketPreset('conservative');
assert.equal(ui.getConfig().muQ, 11);
assert.equal(ui.getConfig().volQ, 22);
assert.equal(ui.getConfig().borrow, 4);
assert.match(element('qldGrowthHint').textContent, /6\.4%/);
ui.applyMarketPreset('balanced');

// Current holdings, optional basis, and future allocation are separately editable.
set('holdingVOO', 200);
set('holdingQLD', 300);
set('holdingJEPQ', 500);
set('basisJEPQ', 400);
set('monthly', 0);
set('initial', 0);
const holdingConfig = ui.getConfig();
assert.deepEqual(Array.from(holdingConfig.currentHoldings), [200, 300, 500]);
assert.deepEqual(Array.from(holdingConfig.currentBasis), [200, 300, 400]);
assert.equal(ui.validate(holdingConfig).length, 0);
ui.updateAllocation();
assert.match(element('holdingsSummary').textContent, /1,000만원/);
assert.match(element('holdingsSummary').textContent, /JEPQ 50.0%/);
set('wJEPQ', 0);
assert.deepEqual(Array.from(ui.getConfig().currentHoldings), [200, 300, 500]);
set('basisJEPQ', 0);
assert.equal(ui.getConfig().currentBasis[2], 0);
set('holdingJEPQ', -1);
assert.ok(ui.validate(ui.getConfig()).length > 0);
set('holdingJEPQ', 0);
set('basisJEPQ', 100);
assert.ok(ui.validate(ui.getConfig()).length > 0);
for (const id of ['holdingVOO', 'holdingQLD', 'holdingJEPQ']) set(id, 0);
for (const id of ['basisVOO', 'basisQLD', 'basisJEPQ']) set(id, '');
set('monthly', 100);
set('wJEPQ', 30);

set('strategyMode', 'month');
ui.updateStrategyControls();
assert.equal(element('dividendTarget').disabled, true);
assert.equal(element('switchAfterMonths').disabled, false);
set('dividendTarget', ''); // Inactive controls must not block validation.
assert.equal(ui.validate(ui.getConfig()).length, 0);
set('switchAfterMonths', 1.5);
assert.ok(ui.validate(ui.getConfig()).length > 0);
set('switchAfterMonths', 480);
ui.updateStrategyControls();
assert.match(element('triggerHelp').textContent, /전환되지 않습니다/);

set('strategyMode', 'none');
set('postVOO', '');
set('postQLD', '');
ui.updateStrategyControls();
assert.equal(element('strategyControls').hidden, true);
assert.equal(ui.validate(ui.getConfig()).length, 0);
set('strategyMode', 'dividend');
set('dividendTarget', 100);
set('postVOO', 0);
set('postQLD', 0);
assert.ok(ui.validate(ui.getConfig()).length > 0);

function render(config) {
  worker.simulate(config);
  ui.inputResult = result;
  ui.inputConfig = config;
  vm.runInContext('lastResult=inputResult;lastConfig=inputConfig;renderAll();', ui);
}
const cfg = { ...defaults, sims: 5, years: 1, initial: 0, monthly: 100, weights: [0, 0, 100], jepqDividendDestination: 'self',
  muQ: 0, volQ: 0, muS: 0, volS: 0, fxOn: false, divJ: 12, alphaJ: 0, feeJ: 0,
  divV: 0, divQ: 0, feeV: 0, feeQ: 0, borrow: 0, whTax: 0, cgTax: 0, dividendTarget: 2 };
render(cfg);
assert.equal(element('switchProbability').textContent, '100.0%');
assert.equal(element('centralSwitch').textContent, '2개월');
assert.equal(element('switchMedian').textContent, '2개월');
assert.match(element('strategyOutcomeNote').textContent, /3개월차/);
assert.match(element('divTable').innerHTML, /2개월차 말 전환/);
assert.match(element('divTable').innerHTML, /200만원/);
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
console.log('model UI integration tests passed');
