// All data in these tests are authored synthetic fixtures. No Deadlock FPS was measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { parseCsv, summarizeCapture, compareRunReports, main } from '../tools/analyze-presentmon.mjs';

const tiny = { minSeconds: 0, minFrames: 2 };
function fixture(frameTimes, options = {}) {
  const metric = options.metric ?? 'FrameTime', timeHeader = options.timeHeader ?? 'CPUStartTime';
  const msTime = options.msTime ?? ['CPUStartTime', 'CPUStartTimeInMs', 'CPUStartQPCTime', 'CPUStartQPCTimeInMs', 'TimeInMs'].includes(timeHeader);
  const header = `Application,ProcessID,SwapChainAddress,PresentRuntime,FrameType,${timeHeader},${metric},CPUBusy,GPUBusy,DisplayedTime`;
  let t = 0;
  const rows = frameTimes.map((ft, i) => {
    const time = options.qpcBase ? (options.qpcBase + BigInt(Math.round(t * 10000))).toString() : (msTime ? t : t / 1000).toFixed(7);
    const r = `${options.app ?? 'deadlock.exe'},${options.pid ?? 1234},${options.chain ?? '0x00001234'},DXGI,Application,${time},${ft},${ft / 2},${ft * .8},${i === 2 ? 'NA' : ft}`;
    t += ft; return r;
  });
  return header + '\n' + rows.join('\n') + '\n';
}
const metadata = () => ({
  evidenceType: 'synthetic', environment: { frameGenerationDisabled: true, shaderCacheWarm: true, foregroundVerifiedDuringCapture: true, sceneConfirmed: true, hags: true },
  collector: { version: '2.6.0', completed: true, exitCode: 0, etwEventsLost: 0, etwBuffersLost: 0, overflowedPresents: 0 },
  comparisonContext: {
    machineId: 'synthetic-test-machine', gameBuildId: 'synthetic-build', driverVersion: 'synthetic-driver', scenarioId: 'synthetic-route',
    renderer: 'DirectX 11', outputWidth: 1920, outputHeight: 1080, outputRefreshHz: 480, fpsMaxRuntime: 0,
    camera: 'Synthetic fixed player view and FOV', backgroundWorkload: 'Synthetic constant background workload',
    scenarioType: 'replay', replaySha256: 'a'.repeat(64), startTick: 100, endTick: 200, playbackSpeed: 1,
  },
});

test('FPS is reciprocal mean interval, not mean reciprocal; tail mean and quantile differ', () => {
  const r = summarizeCapture(fixture([5, 5, 10, 20]), tiny, metadata());
  assert.equal(r.metrics.averageFps, 100);
  assert.equal(r.metrics.onePercentLowFps, 50);
  assert.ok(r.metrics.fpsEquivalentOfP99 > 50);
  assert.ok(Math.abs(r.metrics.frameTimeMs.p99 - 19.7) < 1e-12);
  assert.equal(r.metrics.applicationFramesNotDisplayed, 1);
  assert.equal(r.metrics.frameTimeMs.max, 20);
  assert.equal(r.evidenceType, 'synthetic');
  assert.ok(r.quality.warnings.some((w) => /HAGS/.test(w)));
});
test('supports actual v2.6 default schema and millisecond QPC output', () => {
  const csv = fixture([8, 8, 8], { metric: 'MsBetweenAppStart', timeHeader: 'CPUStartQPCTimeInMs', msTime: true }).replaceAll('CPUBusy,GPUBusy', 'MsCPUBusy,MsGPUBusy');
  const r = summarizeCapture(csv, tiny, metadata());
  assert.equal(r.metrics.averageFps, 125);
  assert.equal(r.analysis.timestampUnit, 'milliseconds');
  assert.equal(r.metrics.gpuBusyMs.p50, 6.4);
});
test('v2 CPUStartTime follows millisecond CLI/runtime schema without guessing values', () => {
  // Authored synthetic 30 FPS values, using the header/precision of the real foreground smoke.
  const csv = 'Application,ProcessID,SwapChainAddress,PresentRuntime,FrameType,CPUStartTime,FrameTime\n' +
    'deadlock.exe,1234,0x1234,DXGI,Application,20.6722,33.3333\n' +
    'deadlock.exe,1234,0x1234,DXGI,Application,54.0055,33.3333\n' +
    'deadlock.exe,1234,0x1234,DXGI,Application,87.3388,33.3333\n';
  const r = summarizeCapture(csv, tiny, metadata());
  assert.equal(r.analysis.timestampUnit, 'milliseconds');
  assert.ok(Math.abs(r.metrics.averageFps - 30) < .0001);
  assert.ok(Math.abs(r.metrics.timelineSeconds - .1) < .000001);
  assert.throws(() => summarizeCapture(csv, { ...tiny, timestampUnit: 'seconds' }, metadata()), /Discontinuous/);
  const explicitSeconds = fixture([10, 10, 10], { timeHeader: 'CPUStartTimeInSeconds' });
  assert.equal(summarizeCapture(explicitSeconds, tiny, metadata()).analysis.timestampUnit, 'seconds');
});
test('supports older CPUFrameTime alias without assuming it is current header', () => {
  const r = summarizeCapture(fixture([10, 10, 10], { metric: 'CPUFrameTime' }), tiny, metadata());
  assert.equal(r.analysis.frameTimeColumn, 'CPUFrameTime');
  assert.equal(r.metrics.averageFps, 100);
});
test('v1 present interval is attributed before its timestamp', () => {
  const csv = 'Application,ProcessID,SwapChainAddress,TimeInSeconds,msBetweenPresents,Dropped\n' +
    'deadlock.exe,1,0x1234,0.01,10,0\ndeadlock.exe,1,0x1234,0.02,10,1\ndeadlock.exe,1,0x1234,0.03,10,0\n';
  const r = summarizeCapture(csv, tiny, metadata());
  assert.equal(r.metrics.averageFps, 100);
  assert.equal(r.analysis.frameInterval, 'preceding-present');
  assert.equal(r.metrics.applicationFramesNotDisplayed, 1);
  assert.ok(r.quality.warnings.some((w) => /No FrameType/.test(w)));
});
test('QPC subtracts with BigInt before floating conversion', () => {
  const csv = fixture([10, 10, 10], { timeHeader: 'CPUStartQPC', qpcBase: 9007199254740993000n });
  assert.throws(() => summarizeCapture(csv, tiny), /QPC timestamps require/);
  const r = summarizeCapture(csv, { ...tiny, qpcFrequency: 10_000_000 }, metadata());
  assert.equal(r.metrics.averageFps, 100);
  assert.equal(r.metrics.coveredSeconds, .03);
});
test('warmup and duration exclude crossing intervals without deleting a stutter', () => {
  const r = summarizeCapture(fixture([10, 10, 50, 10, 10]), { ...tiny, warmup: .02, duration: .06 }, metadata());
  assert.equal(r.metrics.frameCount, 2);
  assert.equal(r.metrics.frameTimeMs.max, 50);
  assert.equal(r.metrics.coveredSeconds, .06);
  assert.equal(r.exclusions.boundaryOrWarmupFrames, 3);
});
test('rejects mixed processes and swapchains unless explicit stream filters select one', () => {
  const a = fixture([10, 10, 10]);
  const b = fixture([10, 10, 10], { app: 'other.exe', pid: 44 });
  const mixed = a + b.slice(b.indexOf('\n') + 1);
  assert.throws(() => summarizeCapture(mixed, tiny), /Mixed processes/);
  assert.equal(summarizeCapture(mixed, { ...tiny, processName: 'deadlock.exe' }).metrics.frameCount, 3);
  const multiplePids = a + fixture([10, 10, 10], { pid: 44 }).split('\n').slice(1).join('\n');
  assert.throws(() => summarizeCapture(multiplePids, { ...tiny, processName: 'deadlock.exe' }), /Mixed processes/);
  assert.equal(summarizeCapture(multiplePids, { ...tiny, processId: 1234 }).metrics.frameCount, 3);
  const multipleChains = a + fixture([10, 10, 10], { chain: '0x9999' }).split('\n').slice(1).join('\n');
  assert.throws(() => summarizeCapture(multipleChains, tiny), /Mixed swapchains/);
  assert.equal(summarizeCapture(multipleChains, { ...tiny, swapchain: '0x00001234' }).metrics.frameCount, 3);
});
test('generated frames never inflate render FPS, and unknown types refuse analysis', () => {
  const csv = fixture([10, 10, 10]);
  const generated = csv + 'deadlock.exe,1234,0x00001234,DXGI,AMD AFMF,5,5,2,4,5\n';
  const r = summarizeCapture(generated, tiny, metadata());
  assert.equal(r.metrics.averageFps, 100);
  assert.equal(r.exclusions.generatedOrRepeatedFrames, 1);
  assert.equal(r.quality.eligibleForComparison, false);
  assert.throws(() => summarizeCapture(csv.replace('Application,10.0000000', 'Unknown,10.0000000'), tiny), /Unclassified/);
  assert.throws(() => summarizeCapture(generated.replaceAll('FrameTime', 'msBetweenPresents'), tiny), /cannot isolate/);
});
test('strict CSV accepts quotes/BOM/multiline fields and rejects truncation/duplicate headers', () => {
  const r = parseCsv('\uFEFFA,B\r\n"a,with\nnewline","a""quote"\r\n');
  assert.equal(r.rows[0].A, 'a,with\nnewline');
  assert.equal(r.rows[0].B, 'a"quote');
  assert.throws(() => parseCsv('A,B\n1,2'), /final newline/);
  assert.throws(() => parseCsv('A,B\n1\n'), /fields/);
  assert.throws(() => parseCsv('A,a\n1,2\n'), /duplicate/);
  assert.throws(() => parseCsv('A,B\n"1,2\n'), /Unterminated/);
});
test('rejects short captures, missing window, invalid timing, reset, trace loss and early exit', () => {
  const csv = fixture([10, 10, 10]);
  assert.throws(() => summarizeCapture(csv), /minimum/);
  assert.throws(() => summarizeCapture(csv, { ...tiny, duration: 120 }), /ends before/);
  assert.throws(() => summarizeCapture(csv.replace(',10.0000000,10,', ',10.0000000,0,'), tiny), /Zero interior/);
  assert.throws(() => summarizeCapture(csv.replace(',10.0000000,10,', ',10.0000000,-10,'), tiny), /Negative/);
  assert.throws(() => summarizeCapture(csv.replace('20.0000000', '10.0000000'), tiny), /Non-increasing/);
  assert.throws(() => summarizeCapture(csv.replace('20.0000000', '25.0000000'), tiny), /Discontinuous/);
  const bad = metadata(); bad.collector.etwEventsLost = 1;
  assert.throws(() => summarizeCapture(csv, tiny, bad), /trace loss|EtwEventsLost/i);
  const early = metadata(); early.collector.completed = false;
  assert.throws(() => summarizeCapture(csv, tiny, early), /did not complete/);
});
test('zero optional GPU telemetry is unknown, not proof of CPU limitation', () => {
  const r = summarizeCapture(fixture([10, 10, 10]).replaceAll(',5,8,', ',5,0,'), tiny);
  assert.equal(r.metrics.gpuBusyToFrameTimeRatio, null);
  assert.equal(r.metrics.gpuBusyMs.nonzeroSamples, 0);
});
test('missing ETW counters remain unknown, and focus loss cannot become valid benchmark evidence', () => {
  const m = metadata(); m.collector.etwEventsLost = null; m.collector.etwBuffersLost = null; m.collector.overflowedPresents = null;
  const r = summarizeCapture(fixture([10, 10, 10]), tiny, m);
  assert.equal(r.quality.traceLossVerified, false);
  assert.equal(r.quality.eligibleForComparison, false);
  assert.ok(r.quality.warnings.some((w) => /event-loss status/.test(w)));
  m.collector.etwEventsLost = 0;
  assert.equal(summarizeCapture(fixture([10, 10, 10]), tiny, m).quality.traceLossVerified, false);
  m.environment.foregroundVerifiedDuringCapture = false;
  assert.throws(() => summarizeCapture(fixture([10, 10, 10]), tiny, m), /lost game focus/);
});
function comparisonFixtures(gain = 10, comparisonContext = undefined) {
  const baselineProfile = 'baseline', candidateProfile = 'candidate'; const runs = [], reports = [];
  for (let block = 1; block <= 3; block++) for (let order = 1; order <= 4; order++) {
    const sequence = block % 2 ? 'ABBA' : 'BAAB'; const profile = sequence[order - 1] === 'A' ? baselineProfile : candidateProfile;
    const m = metadata(); if (comparisonContext !== undefined) m.comparisonContext = structuredClone(comparisonContext);
    const r = summarizeCapture(fixture([10, 10, 10]), { ...tiny, profile, runId: `synthetic-${block}-${order}` }, m);
    // Construct comparator unit inputs; these are never saved or passed off as measurements.
    r.evidenceType = 'comparator-unit-input'; r.source.sha256 = String(block * 10 + order).padStart(64, '0');
    if (profile === candidateProfile) { r.metrics.averageFps *= 1 + gain / 100; r.metrics.onePercentLowFps *= 1 + gain / 100; r.metrics.frameTimeMs.p99 /= 1 + gain / 100; }
    reports.push(r); runs.push({ report: `${block}-${order}.json`, profile, block: String(block), order });
  }
  return [{ baselineProfile, candidateProfile, runs }, reports];
}

test('concrete runtime declarations admit numeric uncapped zero but reject unknown cap, camera and output', () => {
  const r = summarizeCapture(fixture([10, 10, 10]), tiny, metadata());
  assert.equal(r.quality.comparisonContextComplete, true);
  assert.equal(r.quality.eligibleForComparison, true);
  const mutations = [
    ['fpsMaxRuntime', null], ['fpsMaxRuntime', undefined], ['fpsMaxRuntime', '0'],
    ['fpsMaxRuntime', -1], ['fpsMaxRuntime', Infinity], ['fpsMaxRuntime', NaN],
    ['camera', null], ['camera', 'unknown camera'], ['camera', '  '],
    ['backgroundWorkload', undefined], ['backgroundWorkload', 'not verified'],
    ['renderer', null], ['renderer', 'unverified'],
    ['machineId', 'unknown'], ['gameBuildId', null], ['driverVersion', 'pending'], ['scenarioId', ''], ['camera', '<camera description>'],
    ['outputWidth', 0], ['outputHeight', 1080.5], ['outputRefreshHz', null],
  ];
  for (const [key, value] of mutations) {
    const m = metadata(); m.comparisonContext[key] = value;
    const exploratory = summarizeCapture(fixture([10, 10, 10]), tiny, m);
    assert.equal(exploratory.metrics.averageFps, 100, key);
    assert.equal(exploratory.quality.traceLossVerified, true, key);
    assert.equal(exploratory.quality.comparisonContextComplete, false, key);
    assert.equal(exploratory.quality.eligibleForComparison, false, key);
    assert.ok(exploratory.quality.comparisonContextIssues.some((issue) => issue.startsWith(key)), key);
  }
});

test('loaded reports cannot bypass concrete cap or route requirements with stale quality flags', () => {
  for (const [key, value] of [['fpsMaxRuntime', null], ['camera', 'unknown'], ['startTick', null], ['scenarioType', null]]) {
    const [manifest, reports] = comparisonFixtures();
    // Emulate a report produced before context gates, or a hand-edited eligibility flag.
    reports[0].metadata.comparisonContext[key] = value;
    reports[0].quality.eligibleForComparison = true;
    reports[0].quality.comparisonContextComplete = true;
    assert.throws(() => compareRunReports(manifest, reports), /requires concrete known context/, key);
  }
});

test('replay identity accepts a known ID alternative and requires exact ordered ticks and positive speed', () => {
  const m = metadata(); m.comparisonContext.replaySha256 = null; m.comparisonContext.replayId = 'synthetic-current-build-match';
  assert.equal(summarizeCapture(fixture([10, 10, 10]), tiny, m).quality.eligibleForComparison, true);
  m.comparisonContext.startTick = 0;
  assert.equal(summarizeCapture(fixture([10, 10, 10]), tiny, m).quality.eligibleForComparison, true);
  const mutations = [
    { replaySha256: null, replayId: null },
    { replaySha256: 'not-a-hash', replayId: 'unknown' },
    { startTick: -1 }, { startTick: 10.5 }, { endTick: null }, { endTick: 0 },
    { endTick: 0.5 }, { endTick: Number.MAX_SAFE_INTEGER + 1 },
    { playbackSpeed: 0 }, { playbackSpeed: -1 }, { playbackSpeed: null }, { playbackSpeed: '1' },
  ];
  for (const changes of mutations) {
    const bad = structuredClone(m); Object.assign(bad.comparisonContext, changes);
    const r = summarizeCapture(fixture([10, 10, 10]), tiny, bad);
    assert.equal(r.quality.comparisonContextComplete, false, JSON.stringify(changes));
    assert.equal(r.quality.eligibleForComparison, false, JSON.stringify(changes));
  }
  const sameTick = metadata(); sameTick.comparisonContext.endTick = sameTick.comparisonContext.startTick;
  assert.ok(summarizeCapture(fixture([10, 10, 10]), tiny, sameTick).quality.comparisonContextIssues.some((x) => /endTick must exceed/.test(x)));
});

test('native scene comparison requires a concrete map, procedure and state identity without claiming a replay', () => {
  const context = metadata().comparisonContext;
  for (const key of ['replaySha256', 'startTick', 'endTick', 'playbackSpeed']) delete context[key];
  Object.assign(context, { scenarioType: 'native-scene', sceneMap: 'synthetic-map', sceneProcedure: 'Synthetic fixed-view procedure', sceneStateId: 'synthetic-state-001' });
  const [manifest, reports] = comparisonFixtures(10, context);
  const c = compareRunReports(manifest, reports);
  assert.equal(c.scenarioType, 'native-scene');
  assert.equal(c.summary.consistentScenarioImprovement, true);
  assert.equal(c.summary.consistentReplayImprovement, false);
  for (const key of ['sceneMap', 'sceneProcedure', 'sceneStateId']) {
    const m = metadata(); m.comparisonContext = { ...context, [key]: null };
    const r = summarizeCapture(fixture([10, 10, 10]), tiny, m);
    assert.equal(r.quality.eligibleForComparison, false, key);
    assert.ok(r.quality.comparisonContextIssues.some((issue) => issue.startsWith(key)), key);
  }
  reports[1].analysis.requestedDurationSeconds *= 2;
  assert.throws(() => compareRunReports(manifest, reports), /window length/);
});

test('complete context remains an evidence declaration, with mismatched camera or replay range rejected', () => {
  for (const [key, value] of [['camera', 'Synthetic second camera'], ['endTick', 300]]) {
    const [manifest, reports] = comparisonFixtures();
    reports[1].metadata.comparisonContext[key] = value;
    assert.throws(() => compareRunReports(manifest, reports), /comparisonContext differs/, key);
  }
  const [manifest, reports] = comparisonFixtures();
  assert.ok(compareRunReports(manifest, reports).limitations.some((x) => /declaration.*proof/.test(x)));
});

test('all good declarations cannot qualify unknown ETW status, including a stale eligibility flag', () => {
  for (const absent of [null, undefined]) {
    const m = metadata();
    for (const key of ['etwEventsLost', 'etwBuffersLost', 'overflowedPresents']) {
      if (absent === undefined) delete m.collector[key]; else m.collector[key] = absent;
    }
    const [manifest, reports] = comparisonFixtures();
    const r = summarizeCapture(fixture([10, 10, 10]), { ...tiny, profile: reports[0].profile, runId: reports[0].runId }, m);
    assert.equal(r.metrics.averageFps, 100); // Exploratory analysis remains available.
    assert.equal(r.quality.traceLossVerified, false);
    assert.equal(r.quality.eligibleForComparison, false);
    r.evidenceType = 'comparator-unit-input'; r.source.sha256 = reports[0].source.sha256;
    reports[0] = r;
    assert.throws(() => compareRunReports(manifest, reports), /unverified ETW loss status/);
    // Older reports or user edits cannot bypass the independent comparison gate.
    r.quality.eligibleForComparison = true;
    assert.throws(() => compareRunReports(manifest, reports), /unverified ETW loss status/);
  }
});

test('CSV ETW counters must all be known zero, never negative or fractional', () => {
  const withCounters = (counts) => fixture([10, 10, 10]).trimEnd().split('\n').map((line, i) =>
    line + (i === 0 ? ',EtwEventsLost,EtwBuffersLost,OverflowedPresents' : ',' + counts.join(','))).join('\n') + '\n';
  const m = metadata();
  for (const key of ['etwEventsLost', 'etwBuffersLost', 'overflowedPresents']) m.collector[key] = null;
  const r = summarizeCapture(withCounters([0, 0, 0]), tiny, m);
  assert.equal(r.quality.traceLossVerified, true);
  assert.equal(r.quality.eligibleForComparison, true);
  assert.throws(() => summarizeCapture(withCounters([-1, 0, 0]), tiny, m), /Invalid ETW counter/);
  assert.throws(() => summarizeCapture(withCounters([0, .5, 0]), tiny, m), /Invalid ETW counter/);
  assert.throws(() => summarizeCapture(withCounters([0, 0, 1]), tiny, m), /ETW trace loss/);
});

test('an explicit 50-second minimum supports a declared short analysis without weakening coverage', () => {
  const csv = fixture(Array(5000).fill(10));
  assert.throws(() => summarizeCapture(csv, { duration: 50 }), /minimum is 60/);
  const r = summarizeCapture(csv, { duration: 50, minSeconds: 50 }, metadata());
  assert.equal(r.metrics.coveredSeconds, 50);
  assert.equal(r.metrics.requestedWindowCoverageRatio, 1);
  assert.equal(r.metrics.frameCount, 5000);
  assert.throws(() => summarizeCapture(csv, { duration: 60, minSeconds: 50 }), /ends before requested window/);
});
test('ABBA comparison uses blocks, validates controls, and reports bounded measured effect', () => {
  const [manifest, reports] = comparisonFixtures();
  const c = compareRunReports(manifest, reports);
  assert.ok(Math.abs(c.summary.medianAverageFpsGainPercent - 10) < 1e-9);
  assert.equal(c.summary.consistentReplayImprovement, true);
  assert.equal(c.summary.blocks, 3);
  assert.ok(c.limitations.some((x) => /No confidence/.test(x)));
  reports[4].metadata.comparisonContext.driverVersion = 'changed';
  assert.throws(() => compareRunReports(manifest, reports), /comparisonContext differs/);
});
test('comparison rejects fake repetitions, synthetic evidence, missing metadata and ABAB order', () => {
  let [manifest, reports] = comparisonFixtures(); reports[1].source.sha256 = reports[0].source.sha256;
  assert.throws(() => compareRunReports(manifest, reports), /same capture/);
  [manifest, reports] = comparisonFixtures(); reports[0].evidenceType = 'synthetic';
  assert.throws(() => compareRunReports(manifest, reports), /synthetic/);
  [manifest, reports] = comparisonFixtures(); delete reports[0].metadata.comparisonContext;
  assert.throws(() => compareRunReports(manifest, reports), /Missing comparisonContext/);
  [manifest, reports] = comparisonFixtures(); [manifest.runs[2].order, manifest.runs[3].order] = [4, 3];
  assert.throws(() => compareRunReports(manifest, reports), /must be ABBA/);
});
test('small gain or 1% low regression does not establish a useful improvement', () => {
  let [manifest, reports] = comparisonFixtures(1);
  assert.equal(compareRunReports(manifest, reports).summary.consistentReplayImprovement, false);
  [manifest, reports] = comparisonFixtures(10); reports[1].metrics.onePercentLowFps = 70;
  assert.equal(compareRunReports(manifest, reports).summary.consistentReplayImprovement, false);
});
test('CLI writes an offline JSON report and refuses to overwrite the source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deadlock-presentmon-test-'));
  try {
    const input = join(directory, 'synthetic.csv'), output = join(directory, 'report.json');
    await writeFile(input, fixture([10, 10, 10]));
    await main(['analyze', input, '--out', output, '--profile', 'synthetic', '--run-id', 'fixture', '--min-seconds', '0', '--min-frames', '2']);
    const result = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(result.profile, 'synthetic'); assert.equal(result.metrics.averageFps, 100);
    await assert.rejects(() => main(['analyze', input, '--out', input, '--min-seconds', '0', '--min-frames', '2']), /must not overwrite/);
  } finally {
    // Only remove the exact directory created for this test, after verifying its resolved parent.
    assert.equal(await realpath(dirname(directory)), await realpath(tmpdir()));
    assert.ok(basename(resolve(directory)).startsWith('deadlock-presentmon-test-'));
    await rm(directory, { recursive: true });
  }
});
test('pinned source-derived default and v2 synthetic CSV headers yield identical interval results', async () => {
  const results = [];
  for (const name of ['presentmon-2.6-default.synthetic.csv', 'presentmon-2.6-v2.synthetic.csv']) {
    const csv = await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
    results.push(summarizeCapture(csv, tiny, metadata()));
  }
  assert.deepEqual(results[0].metrics.frameTimeMs, results[1].metrics.frameTimeMs);
  assert.equal(results[0].metrics.averageFps, 1000 / 14);
  assert.equal(results[0].analysis.frameTimeColumn, 'MsBetweenAppStart');
  assert.equal(results[1].analysis.frameTimeColumn, 'FrameTime');
});
