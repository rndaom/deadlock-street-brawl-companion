#!/usr/bin/env node
/** Offline CSV analysis only. Does not launch, modify, hook, or send input to a game.
 * Header evidence: GameTechDev/PresentMon v2.6.0 PresentMon/CsvOutput.cpp.
 * Default headers differ from that release's README. Synthetic tests are not FPS evidence.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_VERSION = '1.2.0';
const SOURCE = 'https://github.com/GameTechDev/PresentMon/blob/v2.6.0/PresentMon/CsvOutput.cpp';
const fail = (message) => { throw new Error(message); };
const hash = (text) => createHash('sha256').update(text).digest('hex');
const mean = (a) => a.reduce((s, n) => s + n, 0) / a.length;
const finite = (v, label) => {
  if (String(v).trim() === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(v).trim())) fail(`Invalid ${label}: ${v}`);
  const n = Number(v); if (!Number.isFinite(n)) fail(`Non-finite ${label}`); return n;
};
const positiveOption = (v, fallback, label, zero = false) => {
  const n = v === undefined ? fallback : finite(v, label);
  if (n < 0 || (!zero && n === 0)) fail(`${label} must be ${zero ? 'nonnegative' : 'positive'}`);
  return n;
};
export function percentile(sorted, p) {
  if (!sorted.length || p < 0 || p > 1) fail('Invalid percentile input');
  const x = (sorted.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

/** Strict quoted CSV, including BOM, CRLF and quoted newlines. Never repairs a cut row. */
export function parseCsv(input) {
  let text = input.replace(/^\uFEFF/, '');
  if (!text.endsWith('\n')) fail('CSV has no final newline; may be truncated or still being written');
  const table = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === '"') {
      if (cell || closed) fail('Malformed CSV quoting'); quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] !== '\n') fail('Unsupported bare CR in CSV');
      if (c === '\r') continue;
      row.push(cell); cell = ''; closed = false;
      if (c === '\n') { if (row.some((x) => x.length)) table.push(row); row = []; }
    } else { if (closed) fail('Characters after a quoted CSV field'); cell += c; }
  }
  if (quoted) fail('Unterminated quoted field; CSV is truncated');
  if (table.length < 2) fail('CSV contains no frame rows');
  const header = table.shift().map((x) => x.trim());
  if (header.some((x) => !x) || new Set(header.map((x) => x.toLowerCase())).size !== header.length) fail('Empty or duplicate CSV header');
  const rows = table.map((r, i) => {
    if (r.length !== header.length) fail(`CSV row ${i + 2} has ${r.length} fields; expected ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, r[j].trim()]));
  });
  return { header, rows };
}

function columns(header) {
  const m = new Map(header.map((h) => [h.toLowerCase(), h]));
  return (...names) => names.map((n) => m.get(n.toLowerCase())).find(Boolean);
}
function timestampColumn(find, options, metadata) {
  // Pinned CommandLine.cpp selects MilliSeconds without QPC/date flags; v2 CPUStartTime is ms.
  // Do not infer units from the numeric magnitude. Other producers need an explicit override.
  const candidates = [
    ['CPUStartTimeInSeconds', 'seconds'], ['CPUStartTime', 'milliseconds'],
    ['CPUStartTimeInMs', 'milliseconds'], ['CPUStartQPCTimeInMs', 'milliseconds'],
    ['CPUStartQPCTime', 'milliseconds'], ['CPUStartQPC', 'qpc'],
    ['TimeInSeconds', 'seconds'], ['TimeInMs', 'milliseconds'], ['TimeInQPC', 'qpc'],
  ];
  const found = candidates.map(([name, unit]) => ({ name: find(name), unit })).find((x) => x.name);
  if (!found) fail('No supported numeric timestamp column; date-time and ambiguous QPCTime output are unsupported');
  const override = options.timestampUnit ?? metadata.collector?.timestampUnit;
  if (override) { if (!['seconds', 'milliseconds', 'qpc'].includes(override)) fail('Invalid timestamp unit'); found.unit = override; }
  return found;
}
function metricSummary(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return { samples: s.length, mean: mean(s), p50: percentile(s, .5), p95: percentile(s, .95), p99: percentile(s, .99), max: s.at(-1) };
}
function optionalMetric(rows, name) {
  if (!name) return null;
  const values = rows.map((r) => r[name]).filter((x) => x !== '' && !/^(na|nan|n\/a)$/i.test(x)).map((x) => finite(x, name));
  if (values.some((x) => x < 0)) fail(`Negative ${name}`);
  return { column: name, ...metricSummary(values), nonzeroSamples: values.filter((x) => x > 0).length };
}
function noLoss(rows, find, metadata) {
  for (const name of ['EtwEventsLost', 'EtwBuffersLost', 'OverflowedPresents']) {
    const c = find(name);
    if (c) for (const row of rows) {
      const count = finite(row[c], c);
      if (count < 0 || !Number.isInteger(count)) fail(`Invalid ETW counter ${c}; expected a nonnegative integer`);
      if (count > 0) fail(`ETW trace loss reported in ${c}; recapture`);
    }
    const value = metadata.collector?.[name[0].toLowerCase() + name.slice(1)];
    if (value !== undefined && value !== null && finite(value, name) !== 0) fail(`Capture metadata reports ${name}; recapture`);
  }
}

// Completeness checks recorded declarations; they do not prove runtime readback or scene control.
function comparisonContextIssues(context) {
  if (!context || Array.isArray(context) || typeof context !== 'object') return ['Missing comparisonContext object'];
  const issues = [];
  const knownText = (value) => typeof value === 'string' && value.trim().length > 0 &&
    !/^<[^>]+>$/.test(value.trim()) &&
    !/^(?:unknown|unverified|unspecified|pending|tbd|todo|not recorded|not verified|not known|not available|not measured|unset|null|undefined|n\/a|na|\?+)(?:$|[\s:._-])/i.test(value.trim());
  const text = (key) => { if (!knownText(context[key])) issues.push(`${key} requires a known nonempty string`); };
  const number = (key, zero = false, integer = false) => {
    const value = context[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0) || (integer && !Number.isSafeInteger(value))) {
      issues.push(`${key} requires a finite ${zero ? 'nonnegative' : 'positive'} ${integer ? 'integer' : 'number'}`);
    }
  };
  for (const key of ['machineId', 'gameBuildId', 'driverVersion', 'scenarioId', 'renderer', 'backgroundWorkload', 'camera']) text(key);
  number('outputWidth', false, true); number('outputHeight', false, true); number('outputRefreshHz');
  number('fpsMaxRuntime', true);
  if (context.scenarioType === 'replay') {
    if (!(typeof context.replaySha256 === 'string' && /^[0-9a-f]{64}$/i.test(context.replaySha256)) && !knownText(context.replayId)) {
      issues.push('replay requires replaySha256 (64 hex characters) or a known replayId');
    }
    number('startTick', true, true); number('endTick', true, true);
    if (Number.isSafeInteger(context.startTick) && Number.isSafeInteger(context.endTick) && context.endTick <= context.startTick) issues.push('endTick must exceed startTick');
    number('playbackSpeed');
  } else if (context.scenarioType === 'native-scene') {
    for (const key of ['sceneMap', 'sceneProcedure', 'sceneStateId']) text(key);
  } else issues.push('scenarioType must be replay or native-scene');
  return issues;
}

export function summarizeCapture(csv, options = {}, metadata = {}) {
  const { header, rows } = parseCsv(csv), find = columns(header);
  const app = find('Application'), pid = find('ProcessID'), chain = find('SwapChainAddress');
  if (!app || !pid || !chain) fail('CSV must identify Application, ProcessID and SwapChainAddress');
  const processName = options.processName, processId = options.processId;
  let filtered = rows.filter((r) => (!processName || r[app].toLowerCase() === processName.toLowerCase()) && (processId === undefined || r[pid] === String(processId)));
  if (!filtered.length) fail('Process filters selected no rows');
  const identities = [...new Set(filtered.map((r) => `${r[app].toLowerCase()}|${r[pid]}`))];
  if (identities.length !== 1) fail('Mixed processes/PIDs; choose --process-name and/or --process-id');
  if (!/^\d+$/.test(filtered[0][pid]) || Number(filtered[0][pid]) < 1) fail('Invalid ProcessID');
  if (options.swapchain) filtered = filtered.filter((r) => r[chain].toLowerCase() === options.swapchain.toLowerCase());
  if (!filtered.length) fail('Swapchain filter selected no rows');
  const chains = [...new Set(filtered.map((r) => r[chain].toLowerCase()))];
  if (chains.length !== 1) fail('Mixed swapchains; choose --swapchain (never sum their FPS)');
  if (!/^0x[0-9a-f]+$/i.test(chains[0])) fail('Invalid swapchain address');
  noLoss(filtered, find, metadata);
  if (metadata.collector?.completed === false || (metadata.collector?.exitCode !== undefined && metadata.collector.exitCode !== 0)) fail('Capture did not complete successfully');
  if (metadata.environment?.foregroundVerifiedDuringCapture === false || metadata.validity?.targetLifetimeStable === false) fail('Capture lost game focus or the original game process; recapture');
  const warnings = [];
  const frameType = find('FrameType');
  const generated = [], unknown = [], application = [];
  for (const r of filtered) {
    if (!frameType || r[frameType].toLowerCase() === 'application') application.push(r);
    else if (/^(amd afmf|intel xess-fg|generated|nvidia dlss[- ]fg|repeated)$/i.test(r[frameType])) generated.push(r);
    else unknown.push(r);
  }
  if (unknown.length) fail(`Unclassified FrameType rows (${unknown.length}); disable frame generation and recapture`);
  if (!application.length) fail('No application-rendered frames');
  if (!frameType) warnings.push('No FrameType column: frame generation must be independently confirmed off; this is an unclassified application-present rate');
  if (metadata.environment?.frameGenerationDisabled !== true) warnings.push('AFMF/other frame generation was not documented as disabled; FrameType alone is not a complete driver-state audit');
  const metric = find('MsBetweenAppStart', 'FrameTime', 'CPUFrameTime', 'msBetweenPresents');
  if (!metric) fail('No supported frame-time metric (FrameTime / MsBetweenAppStart / CPUFrameTime / msBetweenPresents)');
  const preceding = metric.toLowerCase() === 'msbetweenpresents';
  if (preceding && generated.length) fail('Present intervals cannot isolate application render rate when generated frames are present');
  const timestamp = timestampColumn(find, options, metadata);
  let qpcBase; const frequency = options.qpcFrequency ?? metadata.collector?.qpcFrequency;
  if (timestamp.unit === 'qpc') {
    if (!frequency || positiveOption(frequency, undefined, 'qpcFrequency') < 1) fail('QPC timestamps require --qpc-frequency');
    if (!/^\d+$/.test(application[0][timestamp.name])) fail('Invalid QPC timestamp');
    qpcBase = BigInt(application[0][timestamp.name]);
  }
  const numericTimes = application.map((r) => {
    if (timestamp.unit === 'qpc') {
      if (!/^\d+$/.test(r[timestamp.name])) fail('Invalid QPC timestamp');
      return Number(BigInt(r[timestamp.name]) - qpcBase) / Number(frequency);
    }
    return finite(r[timestamp.name], timestamp.name) / (timestamp.unit === 'milliseconds' ? 1000 : 1);
  });
  const origin = numericTimes[0], frames = []; let invalidBoundary = 0;
  for (let i = 0; i < application.length; i++) {
    if (i && numericTimes[i] <= numericTimes[i - 1]) fail('Non-increasing application timestamps; duplicate, reset, wrong stream or frame-generation contamination');
    const ft = finite(application[i][metric], metric);
    if (ft < 0) fail('Negative frame time');
    if (ft === 0) {
      if (i !== 0 && i !== application.length - 1) fail('Zero interior frame time; unsupported/incomplete metrics');
      invalidBoundary++; continue;
    }
    const time = numericTimes[i] - origin;
    frames.push({ row: application[i], frameTimeMs: ft, start: time - (preceding ? ft / 1000 : 0), end: time + (preceding ? 0 : ft / 1000) });
  }
  if (frames.length < 2) fail('Not enough valid frame intervals');
  const warmup = positiveOption(options.warmup, 0, 'warmup', true);
  const minSeconds = positiveOption(options.minSeconds, 60, 'minSeconds', true);
  const minFrames = positiveOption(options.minFrames, 300, 'minFrames');
  if (!Number.isInteger(minFrames)) fail('minFrames must be an integer');
  const availableStart = frames[0].start, availableEnd = frames.at(-1).end;
  const windowStart = availableStart + warmup;
  const duration = positiveOption(options.duration, availableEnd - windowStart, 'duration');
  const windowEnd = windowStart + duration;
  // The CLI's first/last buffered events can fall just short of --timed. Allow 250 ms,
  // but report the actual analyzed duration, rather than inventing missing frames.
  if (windowEnd > availableEnd + .25) fail(`Capture ends before requested window (${availableEnd - windowStart}s available, ${duration}s requested)`);
  const selected = frames.filter((f) => f.start >= windowStart - 1e-6 && f.end <= Math.min(windowEnd, availableEnd) + 1e-6);
  const selectedSet = new Set(selected);
  if (selected.length < minFrames) fail(`Only ${selected.length} frames; minimum is ${minFrames}`);
  for (let i = 1; i < selected.length; i++) {
    if (Math.abs(selected[i].start - selected[i - 1].end) > .00025) fail('Discontinuous application frame intervals; missing events, wrong units or inconsistent timing metrics');
  }
  const fts = selected.map((f) => f.frameTimeMs), sorted = [...fts].sort((a, b) => a - b);
  const coveredSeconds = fts.reduce((s, x) => s + x, 0) / 1000;
  const timelineSeconds = selected.at(-1).end - selected[0].start;
  if (coveredSeconds + .25 < minSeconds) fail(`Only ${coveredSeconds}s of frame intervals; minimum is ${minSeconds}s`);
  if (coveredSeconds / duration < .98) fail('Less than 98% of the requested analysis window is represented; recapture with enough lead-in/tail');
  const coverageRatio = coveredSeconds / timelineSeconds;
  if (Math.abs(coverageRatio - 1) > .02) fail(`Frame intervals cover ${(100 * coverageRatio).toFixed(2)}% of the timeline; wrong units, missing events or overlapping metrics`);
  const tailCount = Math.max(1, Math.ceil(sorted.length * .01)), tailMean = mean(sorted.slice(-tailCount));
  if (tailCount < 30) warnings.push(`1% low uses only ${tailCount} tail frames; longer captures improve stability`);
  if (generated.length) warnings.push(`Excluded ${generated.length} generated/repeated frames; capture again with generation off before comparing profiles`);
  if (metadata.environment?.shaderCacheWarm !== true) warnings.push('Shader/asset warmup is not documented; first-run compilation may confound results');
  if (metadata.collector?.completed !== true) warnings.push('CSV alone cannot prove complete capture or detect truncation at a whole-row boundary');
  const traceLossVerified = ['EtwEventsLost', 'EtwBuffersLost', 'OverflowedPresents'].every((name) => metadata.collector?.[name[0].toLowerCase() + name.slice(1)] === 0 || Boolean(find(name)));
  if (!traceLossVerified) warnings.push('ETW event-loss status is unavailable or incomplete; CSV timing checks do not prove zero lost events/buffers/overflowed presents');
  if (metadata.environment?.foregroundVerifiedDuringCapture !== true || metadata.environment?.sceneConfirmed !== true) warnings.push('Comparable scene and foreground validity were not explicitly recorded');
  const contextIssues = comparisonContextIssues(metadata.comparisonContext), contextComplete = contextIssues.length === 0;
  if (!contextComplete) warnings.push('Concrete comparison context is incomplete: ' + contextIssues.join('; '));
  if (Array.isArray(metadata.warnings)) warnings.push(...metadata.warnings.filter((x) => typeof x === 'string'));
  if (metadata.environment?.hags === true) warnings.push('HAGS is enabled; PresentMon GPU execution timing can be less accurate');
  const runtimes = [...new Set(filtered.map((r) => r[find('PresentRuntime', 'Runtime')]).filter(Boolean))];
  if (runtimes.includes('Other')) warnings.push('Vulkan/Other presentation instrumentation has weaker CPU pacing/latency attribution');
  const gpu = optionalMetric(selected.map((f) => f.row), find('MsGPUBusy', 'GPUBusy', 'msGPUActive'));
  const cpu = optionalMetric(selected.map((f) => f.row), find('MsCPUBusy', 'CPUBusy'));
  const threshold = (ms) => ({ thresholdMs: ms, count: fts.filter((x) => x > ms).length, percent: 100 * fts.filter((x) => x > ms).length / fts.length });
  const display = find('DisplayedTime');
  const displayInterval = find('MsBetweenDisplayChange', 'msBetweenDisplayChange');
  const dropped = find('Dropped');
  const undisplayed = dropped ? selected.filter((f) => f.row[dropped] === '1').length : display ? selected.filter((f) => /^(na|n\/a)$/i.test(f.row[display])).length : null;
  return {
    schemaVersion: 1, tool: { name: 'deadlock-presentmon-analysis', version: TOOL_VERSION, schemaEvidence: SOURCE },
    createdUtc: new Date().toISOString(), evidenceType: metadata.evidenceType ?? 'user-supplied-capture',
    source: { path: options.sourcePath ?? null, sha256: hash(csv), header, collectorVersion: metadata.collector?.version ?? null },
    profile: options.profile ?? metadata.profile?.id ?? 'untagged', runId: options.runId ?? metadata.runId ?? 'untagged', metadata,
    stream: { application: filtered[0][app], processId: Number(filtered[0][pid]), swapchain: chains[0], presentRuntimes: runtimes },
    analysis: { frameTimeColumn: metric, timestampColumn: timestamp.name, timestampUnit: timestamp.unit, frameInterval: preceding ? 'preceding-present' : 'application-start-to-next-start', warmupSeconds: warmup, requestedDurationSeconds: duration, actualStartSeconds: selected[0].start, actualEndSeconds: selected.at(-1).end },
    exclusions: { rowsFromOtherStreams: rows.length - filtered.length, generatedOrRepeatedFrames: generated.length, invalidBoundaryFrames: invalidBoundary, boundaryOrWarmupFrames: frames.length - selected.length, windowBoundaryIntervals: frames.filter((f) => f.start < windowEnd && f.end > windowStart && !selectedSet.has(f)).map((f) => ({ startSeconds: f.start, endSeconds: f.end, frameTimeMs: f.frameTimeMs })) },
    quality: { warnings: [...new Set(warnings)], eligibleForComparison: contextComplete && traceLossVerified && metadata.environment?.frameGenerationDisabled === true && metadata.environment?.shaderCacheWarm === true && metadata.environment?.foregroundVerifiedDuringCapture === true && metadata.environment?.sceneConfirmed === true && metadata.collector?.completed === true && generated.length === 0, traceLossVerified, comparisonContextComplete: contextComplete, comparisonContextIssues: contextIssues },
    metrics: {
      frameCount: fts.length, coveredSeconds, timelineSeconds, coverageRatio, requestedWindowCoverageRatio: coveredSeconds / duration,
      averageFps: 1000 / mean(fts), averageFpsDefinition: '1000 / arithmetic mean of application frame intervals in milliseconds; never arithmetic mean of per-frame FPS',
      onePercentLowFps: 1000 / tailMean, onePercentLowDefinition: '1000 / mean of the slowest ceil(N * 0.01) frame intervals', onePercentTailFrames: tailCount,
      fpsEquivalentOfP99: 1000 / percentile(sorted, .99), fpsEquivalentOfP99Definition: '1000 / p99 frame time; different from mean-tail 1% low',
      frameTimeMs: { mean: mean(fts), p50: percentile(sorted, .5), p95: percentile(sorted, .95), p99: percentile(sorted, .99), p999: percentile(sorted, .999), max: sorted.at(-1), percentileDefinition: 'linear interpolation at (N - 1) * p' },
      slowFrames: [threshold(1000 / 120), threshold(1000 / 60), threshold(1000 / 30), threshold(2 * percentile(sorted, .5))],
      applicationFramesNotDisplayed: undisplayed,
      displayIntervalMissing: displayInterval ? selected.filter((f) => /^(na|n\/a)$/i.test(f.row[displayInterval])).length : null,
      cpuBusyMs: cpu, gpuBusyMs: gpu,
      gpuBusyToFrameTimeRatio: gpu?.nonzeroSamples ? gpu.mean / mean(fts) : null,
      bottleneckNote: 'GPU-busy/frame-time ratio is a timing clue only. Confirm with controlled render-resolution tests; total CPU utilization, caps, HAGS, Vulkan, scheduling and missing instrumentation can confound attribution.',
    },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
function cv(values) { const m = mean(values); return 100 * Math.sqrt(mean(values.map((x) => (x - m) ** 2))) / m; }
export function compareRunReports(manifest, reports) {
  if (!Array.isArray(manifest.runs) || manifest.runs.length !== reports.length || reports.length < 12) fail('Comparison needs at least three complete four-run ABBA/BAAB blocks');
  if (!manifest.baselineProfile || !manifest.candidateProfile || manifest.baselineProfile === manifest.candidateProfile) fail('Set different baselineProfile and candidateProfile');
  let contextSignature, methodSignature; const blocks = new Map();
  const seenRunIds = new Set(), seenHashes = new Set();
  for (let i = 0; i < reports.length; i++) {
    const report = reports[i], entry = manifest.runs[i];
    if (report.schemaVersion !== 1 || report.tool?.name !== 'deadlock-presentmon-analysis') fail('Unsupported run report');
    if (report.quality?.traceLossVerified !== true) fail('Run has unverified ETW loss status; only known-zero events/buffers/overflow may enter verified comparison');
    const context = report.metadata?.comparisonContext, contextIssues = comparisonContextIssues(context);
    if (contextIssues.length) fail('Verified comparison requires concrete known context: ' + contextIssues.join('; '));
    if (!report.quality.eligibleForComparison || report.evidenceType === 'synthetic') fail('Run has unverified capture/warmup/frame-generation state or synthetic evidence');
    if (!entry.block || !Number.isInteger(entry.order) || entry.order < 1 || entry.order > 4) fail('Each run needs a block and order 1..4');
    if (entry.profile !== report.profile || ![manifest.baselineProfile, manifest.candidateProfile].includes(report.profile)) fail('Manifest/report profile mismatch');
    if (report.runId === 'untagged' || seenRunIds.has(report.runId)) fail('Run IDs must be unique and explicitly tagged'); seenRunIds.add(report.runId);
    if (!/^[0-9a-f]{64}$/i.test(report.source.sha256) || seenHashes.has(report.source.sha256)) fail('CSV hashes must be valid and distinct; do not count the same capture as repeated evidence'); seenHashes.add(report.source.sha256);
    if (!report.source.collectorVersion || report.source.collectorVersion === 'unknown') fail('Collector version must be recorded');
    const signature = JSON.stringify(canonical(context));
    if (contextSignature && signature !== contextSignature) fail('Run comparisonContext differs; do not combine changed builds, scenes or machine conditions'); contextSignature = signature;
    const method = JSON.stringify([report.analysis.frameTimeColumn, report.analysis.timestampUnit, report.analysis.warmupSeconds, report.analysis.requestedDurationSeconds, report.source.collectorVersion]);
    if (methodSignature && method !== methodSignature) fail('Run analysis method, window length or collector version differs'); methodSignature = method;
    if (!blocks.has(entry.block)) blocks.set(entry.block, []);
    blocks.get(entry.block).push({ entry, report });
  }
  if (blocks.size < 3) fail('At least three independent blocks are required');
  const results = [];
  for (const [id, entries] of blocks) {
    const ordered = entries.sort((a, b) => a.entry.order - b.entry.order);
    if (ordered.length !== 4 || ordered.some((r, i) => r.entry.order !== i + 1)) fail(`Block ${id} is incomplete or has duplicate order`);
    const order = ordered.map((x) => x.report.profile === manifest.baselineProfile ? 'A' : 'B').join('');
    if (!['ABBA', 'BAAB'].includes(order)) fail(`Block ${id} must be ABBA or BAAB, got ${order}`);
    const a = ordered.filter((x) => x.report.profile === manifest.baselineProfile).map((x) => x.report.metrics);
    const b = ordered.filter((x) => x.report.profile === manifest.candidateProfile).map((x) => x.report.metrics);
    for (const m of [...a, ...b]) {
      if (![m.averageFps, m.onePercentLowFps, m.frameTimeMs?.p99, m.coveredSeconds].every((v) => Number.isFinite(v) && v > 0)) fail('Invalid report metrics');
    }
    const aFps = mean(a.map((m) => m.averageFps)), bFps = mean(b.map((m) => m.averageFps));
    const aLow = mean(a.map((m) => m.onePercentLowFps)), bLow = mean(b.map((m) => m.onePercentLowFps));
    const a99 = mean(a.map((m) => m.frameTimeMs.p99)), b99 = mean(b.map((m) => m.frameTimeMs.p99));
    results.push({ block: id, order, baselineAverageFps: aFps, candidateAverageFps: bFps, averageFpsGainPercent: 100 * (bFps / aFps - 1), onePercentLowGainPercent: 100 * (bLow / aLow - 1), p99FrameTimeChangePercent: 100 * (b99 / a99 - 1), baselineRepeatSpreadPercent: 100 * Math.abs(a[0].averageFps - a[1].averageFps) / aFps, candidateRepeatSpreadPercent: 100 * Math.abs(b[0].averageFps - b[1].averageFps) / bFps });
  }
  const gains = results.map((r) => r.averageFpsGainPercent).sort((a, b) => a - b);
  const repeatNoise = Math.max(...results.flatMap((r) => [r.baselineRepeatSpreadPercent, r.candidateRepeatSpreadPercent]));
  const threshold = Math.max(3, repeatNoise);
  const consistent = results.every((r) => r.averageFpsGainPercent > 0 && r.onePercentLowGainPercent >= -3 && r.p99FrameTimeChangePercent <= 3) && percentile(gains, .5) > threshold;
  return {
    schemaVersion: 1, tool: { name: 'deadlock-presentmon-comparison', version: TOOL_VERSION }, createdUtc: new Date().toISOString(),
    baselineProfile: manifest.baselineProfile, candidateProfile: manifest.candidateProfile,
    design: 'paired four-run ABBA/BAAB blocks, each block is the independent unit', scenarioType: reports[0].metadata.comparisonContext.scenarioType, comparisonContext: reports[0].metadata.comparisonContext,
    blocks: results, summary: { blocks: results.length, runs: reports.length, medianAverageFpsGainPercent: percentile(gains, .5), minBlockGainPercent: gains[0], maxBlockGainPercent: gains.at(-1), baselineAverageFpsCvPercent: cv(reports.filter((r) => r.profile === manifest.baselineProfile).map((r) => r.metrics.averageFps)), candidateAverageFpsCvPercent: cv(reports.filter((r) => r.profile === manifest.candidateProfile).map((r) => r.metrics.averageFps)), observedNoiseThresholdPercent: threshold, consistentScenarioImprovement: consistent, consistentReplayImprovement: consistent && reports[0].metadata.comparisonContext.scenarioType === 'replay' },
    conclusion: consistent ? 'Consistent improvement in this recorded scenario; validate visual quality and live-match behavior before selecting the profile.' : 'No improvement established above observed repeat variation with the frame-time guardrails; retain baseline or capture more comparable runs.',
    limitations: ['No confidence interval or causal certainty is claimed from three blocks.', 'Recorded scenario performance does not establish live network/simulation, input latency, late-match stability or universal performance.', 'Complete matched context is a recorded declaration, not automatic proof of runtime readback, scene state or reproduced route/camera.', ...new Set(reports.flatMap((r) => r.quality.warnings))],
    runs: manifest.runs.map((r, i) => ({ ...r, runId: reports[i].runId, csvSha256: reports[i].source.sha256 })),
  };
}

const HELP = `Offline Deadlock PresentMon analysis (no dependencies, game changes, or telemetry upload).
  node analyze-presentmon.mjs analyze capture.csv --out report.json [--metadata capture.json]
    --profile TAG --run-id ID --warmup SECONDS --duration SECONDS
    --process-name deadlock.exe --process-id PID --swapchain 0xADDRESS
    --min-seconds 60 --min-frames 300 --qpc-frequency HZ --timestamp-unit seconds|milliseconds|qpc
  node analyze-presentmon.mjs compare manifest.json --out comparison.json
Comparison manifest: baselineProfile, candidateProfile, runs:[{report,profile,block,order}].
Report paths are relative to the manifest; at least three ABBA/BAAB blocks are required.
Verified context needs machine/build/driver/scenario, renderer, output size/refresh, numeric fpsMaxRuntime (0=uncapped), camera and backgroundWorkload.
scenarioType=replay needs replaySha256 or replayId, integer start/end ticks, playbackSpeed; native-scene needs sceneMap/sceneProcedure/sceneStateId.
Untrimmed stutters remain in the distribution. 1% low is the mean-tail definition.
`;
export async function main(argv) {
  if (!argv.length || argv.includes('--help')) { process.stdout.write(HELP); return; }
  const [command, input, ...rest] = argv;
  if (!['analyze', 'compare'].includes(command) || !input || input.startsWith('--')) fail(HELP);
  const opts = {};
  const keys = { '--out': 'out', '--metadata': 'metadata', '--profile': 'profile', '--run-id': 'runId', '--warmup': 'warmup', '--duration': 'duration', '--process-name': 'processName', '--process-id': 'processId', '--swapchain': 'swapchain', '--min-seconds': 'minSeconds', '--min-frames': 'minFrames', '--qpc-frequency': 'qpcFrequency', '--timestamp-unit': 'timestampUnit' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = keys[rest[i]], value = rest[i + 1];
    if (!key || value === undefined || value.startsWith('--') || opts[key] !== undefined) fail(`Invalid/duplicate CLI option ${rest[i]}`);
    opts[key] = value;
  }
  if (!opts.out) fail('--out is required');
  const sourcePath = resolve(input), inputText = await readFile(sourcePath, 'utf8');
  let result; const inputs = [sourcePath];
  if (command === 'analyze') {
    if (opts.metadata) inputs.push(resolve(opts.metadata));
    const metadata = opts.metadata ? JSON.parse(await readFile(resolve(opts.metadata), 'utf8')) : {};
    if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') fail('Metadata must be an object');
    result = summarizeCapture(inputText, { ...opts, sourcePath }, metadata);
  } else {
    const manifest = JSON.parse(inputText);
    if (!Array.isArray(manifest.runs)) fail('Manifest needs a runs array');
    const paths = manifest.runs.map((r) => resolve(dirname(sourcePath), r.report)); inputs.push(...paths);
    const reports = await Promise.all(paths.map(async (p) => JSON.parse(await readFile(p, 'utf8'))));
    result = compareRunReports(manifest, reports);
  }
  const output = resolve(opts.out);
  const identity = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
  if (inputs.some((p) => identity(p) === identity(output))) fail('Output must not overwrite its input');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ saved: output, type: command, averageFps: result.metrics?.averageFps, consistentScenarioImprovement: result.summary?.consistentScenarioImprovement, consistentReplayImprovement: result.summary?.consistentReplayImprovement }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((e) => { process.stderr.write(`Analysis refused: ${e.message}\n`); process.exitCode = 1; });
