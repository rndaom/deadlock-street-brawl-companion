import { createHash } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Parse KV1 without executing anything. Source positions let us retain unrelated
// preferences, comments, whitespace and Valve's display/device identifiers.
export function parseKv(source) {
  const tokens = [];
  const pattern = /\s+|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|[{}]|[^\s{}"]+/gy;
  let cursor = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (cursor < source.length) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Invalid KeyValues token at offset ${cursor}`);
    const raw = match[0];
    const end = pattern.lastIndex;
    if (!/^\s/.test(raw) && !raw.startsWith('//')) {
      const quoted = raw.startsWith('"');
      const value = quoted ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1') : raw;
      tokens.push({ raw, value, start: cursor, end, quoted });
    }
    cursor = end;
  }
  let index = 0;
  function children(nested = false) {
    const nodes = [];
    while (index < tokens.length && tokens[index].raw !== '}') {
      const key = tokens[index++];
      const value = tokens[index++];
      if (!value || key.raw === '{' || value.raw === '}') throw new Error('Malformed KeyValues pair');
      if (value.raw === '{') {
        const members = children(true);
        const close = tokens[index++];
        if (!close || close.raw !== '}') throw new Error('Unclosed KeyValues object');
        nodes.push({ key: key.value, children: members, start: key.start, end: close.end, close: close.start });
      } else {
        nodes.push({ key: key.value, value: value.value, token: value, start: key.start, end: value.end });
      }
    }
    if (!nested && index !== tokens.length) throw new Error('Unexpected closing brace');
    return nodes;
  }
  const result = children();
  if (index !== tokens.length) throw new Error('Trailing KeyValues tokens');
  return result;
}

function objectAt(nodes, path) {
  let selected;
  for (const name of path) {
    const found = nodes.filter((node) => node.key === name);
    if (found.length !== 1 || !found[0].children) throw new Error(`Expected one object: ${path.join('/')}`);
    selected = found[0];
    nodes = selected.children;
  }
  return selected;
}

export function scalarMap(source, path, { allowNested = false } = {}) {
  const object = objectAt(parseKv(source), path);
  const result = {};
  for (const node of object.children) {
    if (node.children) {
      if (allowNested) continue;
      throw new Error(`Unexpected nested object: ${node.key}`);
    }
    if (!(node.key in result)) result[node.key] = [];
    result[node.key].push(node.value);
  }
  return result;
}

const quote = (text) => '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

export function settingValuesEqual(key, actual, desired) {
  actual = String(actual);
  desired = String(desired);
  if (actual === desired) return true;
  // The game's archive writer serialized our FPS cap as "0" after startup.
  // Accept equivalent finite decimal spellings for this numeric setting only;
  // file hashes and concurrent-write checks remain byte-exact.
  if (!['fps_max', 'setting.fps_max'].includes(key)) return false;
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  if (!decimal.test(actual) || !decimal.test(desired)) return false;
  return Number.isFinite(Number(actual)) && Number.isFinite(Number(desired)) && Number(actual) === Number(desired);
}

export function patchKv(source, path, settings, remove = []) {
  const object = objectAt(parseKv(source), path);
  const removal = new Set(remove);
  const seen = new Set();
  const edits = [];
  const changes = [];
  for (const node of object.children) {
    if (removal.has(node.key)) {
      edits.push({ start: node.start, end: node.end, text: '' });
      changes.push({ key: node.key, before: node.value, after: null, reason: 'legacy override removed' });
    } else if (Object.hasOwn(settings, node.key)) {
      if (node.children) throw new Error(`Scalar setting is an object: ${node.key}`);
      if (seen.has(node.key)) {
        edits.push({ start: node.start, end: node.end, text: '' });
        changes.push({ key: node.key, before: node.value, after: null, reason: 'duplicate removed' });
      } else {
        seen.add(node.key);
        const desired = String(settings[node.key]);
        if (!settingValuesEqual(node.key, node.value, desired)) {
          edits.push({ start: node.token.start, end: node.token.end, text: quote(desired) });
          changes.push({ key: node.key, before: node.value, after: desired, reason: 'native setting' });
        }
      }
    }
  }
  const missing = Object.keys(settings).filter((key) => !seen.has(key));
  if (missing.length) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const indentation = '\t'.repeat(path.length);
    const text = missing.map((key) => `${indentation}${quote(key)}\t\t${quote(settings[key])}${newline}`).join('');
    const prefix = source.slice(0, object.close).endsWith(newline) ? '' : newline;
    edits.push({ start: object.close, end: object.close, text: prefix + text });
    for (const key of missing) changes.push({ key, before: null, after: String(settings[key]), reason: 'native setting added' });
  }
  let result = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  const final = scalarMap(result, path);
  for (const [key, value] of Object.entries(settings)) {
    if (final[key]?.length !== 1 || !settingValuesEqual(key, final[key][0], value)) throw new Error(`Patch verification failed for ${key}`);
  }
  for (const key of removal) if (key in final) throw new Error(`Removal verification failed for ${key}`);
  return { content: result, changes };
}

// These are nonmenu manual renderer overrides in this machine's preexisting
// video.txt. We reset them to the engine's normal behavior. This is neither a
// cheat unlock nor a claim that each old storage key was ever effective.
export const LEGACY_VIDEO_KEYS = Object.freeze([
  'setting.r_shadows', 'setting.r_citadel_distancefield_shadows',
  'setting.csm_max_shadow_dist_override', 'setting.csm_max_num_cascades_override',
  'setting.csm_viewmodel_shadows', 'setting.lb_enable_shadow_casting',
  'setting.lb_dynamic_shadow_resolution', 'setting.r_area_lights',
  'setting.r_citadel_ssao', 'setting.r_citadel_distancefield_ao_quality',
  'setting.volume_fog_width', 'setting.volume_fog_height', 'setting.volume_fog_depth',
  'setting.lb_shadow_texture_width_override', 'setting.lb_shadow_texture_height_override',
  'setting.r_displacement_mapping', 'setting.r_particle_max_detail_level',
  'setting.r_particle_shadows', 'setting.r_particle_cables_cast_shadows',
  'setting.r_citadel_half_res_noisy_effects', 'setting.cl_particle_fallback_base',
  'setting.cl_particle_fallback_multiplier', 'setting.r_distancefield_enable',
  'setting.r_citadel_outlines', 'setting.r_citadel_distancefield_reflections',
  'setting.r_screen_space_shadows', 'setting.r_render_portals',
  'setting.r_env_map_uses_height_map', 'setting.r_citadel_mboit',
  'setting.lb_csm_override_staticgeo_cascades', 'setting.lb_csm_override_staticgeo_cascades_value',
]);

// All values below are mapped to this build's Valve menu or stock low preset.
// GPU type, resolution, monitor, accessibility, input and audio are preserved.
export const BASE_VIDEO = Object.freeze({
  'setting.mat_vsync': '0',
  'setting.r_citadel_ssao_quality': '0',
  'setting.r_effects_bloom': 'false',
  'setting.r_post_bloom': 'false',
  'setting.r_citadel_antialiasing': '0',
  'setting.r_depth_of_field': 'false',
  'setting.r_arealights': 'false',
  'setting.r_texture_stream_mip_bias': '2',
  'setting.r_dashboard_render_quality': '0',
  'setting.r_particle_depth_feathering': 'false',
  'setting.shaderquality': '0',
  'setting.r_citadel_fog_quality': '0',
  'setting.r_citadel_motion_blur': '0',
  'setting.r_citadel_shadow_quality': '0',
  'setting.r_low_latency': '1',
  'setting.fps_max': '0',
  'setting.useadvanced': '1',
});

// Advanced comparison profiles use common sharpening storage values so a pair
// can change only the selected control. The two algorithms do not necessarily
// interpret 0.2 as the same visual strength. The installed profile below stays
// unchanged; these specifications are candidates, never measured winners.
const COMPARISON_VIDEO = Object.freeze({
  ...BASE_VIDEO,
  'setting.r_citadel_upscaling': '1',
  'setting.mat_viewportscale': '0.800000',
  'setting.r_citadel_fsr_rcas_sharpness': '0.200000',
  'setting.r_citadel_fsr2_sharpness': '0.200000',
});

export const PROFILES = Object.freeze({
  aggressive: {
    name: 'Aggressive readable — FSR1 80%',
    video: { ...BASE_VIDEO, 'setting.r_citadel_upscaling': '1', 'setting.mat_viewportscale': '0.800000', 'setting.r_citadel_fsr_rcas_sharpness': '0.200000' },
    description: '1536×864 scene, 1920×1080 output/HUD on this machine. Removes temporal FSR2 reconstruction cost; GPU benefit and clarity require measurement.',
  },
  native: {
    name: 'Native low — 1080p',
    video: { ...BASE_VIDEO, 'setting.r_citadel_upscaling': '0', 'setting.mat_viewportscale': '1.000000' },
    description: 'Native scene with no AA/upscaler. Use when dense scenes are CPU limited or distant small targets suffer at 80%.',
  },
  fsr2quality: {
    name: 'Temporal comparison — FSR2 Quality',
    video: { ...BASE_VIDEO, 'setting.r_citadel_upscaling': '2', 'setting.mat_viewportscale': '0.666667', 'setting.r_citadel_fsr2_sharpness': '0.200000' },
    description: 'Official Quality ratio (~1280×720 internal); optional measured challenger, never auto-selected as a winner.',
  },
  fsr3quality: {
    name: 'Temporal comparison — FSR3 Quality',
    video: { ...BASE_VIDEO, 'setting.r_citadel_upscaling': '3', 'setting.mat_viewportscale': '0.666667', 'setting.r_citadel_fsr2_sharpness': '0.200000' },
    description: 'Current Valve menu labels FSR3 as TAA. Compare at the official Quality ratio; this profile does not enable frame generation.',
  },
  fsr1control: {
    name: 'Comparison control — FSR1 80%',
    video: { ...COMPARISON_VIDEO },
    description: 'Same active graphics as the installed profile, with both sharpening storage controls fixed at 0.2 for comparisons. No measured FPS result.',
  },
  fpsfirst: {
    name: 'FPS-first candidate — FSR1 67%',
    video: { ...COMPARISON_VIDEO, 'setting.mat_viewportscale': '0.666667' },
    description: 'About 1280×720 scene with 1920×1080 HUD/output. About 30.56% fewer scene pixels than 80% scale; actual FPS and distant-target clarity require a replay comparison.',
  },
  fsr160: {
    name: 'Lower-resolution candidate — FSR1 60%',
    video: { ...COMPARISON_VIDEO, 'setting.mat_viewportscale': '0.600000' },
    description: '1152×648 scene with 1920×1080 output/HUD. A supported custom slider ratio, not a declared readability or performance winner.',
  },
  stretch80: {
    name: 'Equal-scale candidate — Stretch 80%',
    video: { ...COMPARISON_VIDEO, 'setting.r_citadel_upscaling': '0' },
    description: 'Same 1536×864 scene as FSR1 80%; removes the FSR reconstruction choice. Compare aliasing and clarity alongside frame times.',
  },
  stretch67: {
    name: 'Equal-scale candidate — Stretch 67%',
    video: { ...COMPARISON_VIDEO, 'setting.r_citadel_upscaling': '0', 'setting.mat_viewportscale': '0.666667' },
    description: 'Same scene ratio and sharpening storage values as FSR1 67% and temporal Quality profiles. This isolates the reconstruction choice, subject to runtime verification.',
  },
  fsr1fxaa: {
    name: 'Clarity comparison — FSR1 80% with FXAA',
    video: { ...COMPARISON_VIDEO, 'setting.r_citadel_antialiasing': '1' },
    description: 'Changes only native anti-aliasing versus the FSR1 comparison control. FSR1 does not provide anti-aliasing; test FXAA cost and moving-target clarity.',
  },
  throughput80: {
    name: 'Throughput comparison — FSR1 80%, Anti-Lag off',
    video: { ...COMPARISON_VIDEO, 'setting.r_low_latency': '0' },
    description: 'Changes only native low-latency mode versus the FSR1 comparison control. Anti-Lag is input pacing, not a guaranteed FPS improvement; disabling it may worsen latency.',
  },
  fsr2control: {
    name: 'Compatibility control — original FSR2 80% values',
    video: { ...BASE_VIDEO, 'setting.r_citadel_upscaling': '2', 'setting.mat_viewportscale': '0.79999995', 'setting.r_citadel_fsr_rcas_sharpness': '0', 'setting.r_citadel_fsr2_sharpness': '0' },
    description: 'Retains the original custom temporal scale and sharpening values while normalizing old overrides. Not a native temporal menu preset; verify acceptance and compare against the preserved original before crediting cleanup with a gain.',
  },
  fsr2equal67: {
    name: 'Equal-scale candidate — FSR2 Quality',
    video: { ...COMPARISON_VIDEO, 'setting.r_citadel_upscaling': '2', 'setting.mat_viewportscale': '0.666667' },
    description: 'Native Quality ratio with common sharpening storage values; differs only in upscaler selection from the FSR1 67% candidate.',
  },
  fsr3equal67: {
    name: 'Equal-scale candidate — FSR3 Quality',
    video: { ...COMPARISON_VIDEO, 'setting.r_citadel_upscaling': '3', 'setting.mat_viewportscale': '0.666667' },
    description: 'Native Quality ratio with common sharpening storage values. Backend support and effective FSR3 selection must be verified on the current DX11 renderer before comparison.',
  },
});

export const MACHINE_SETTINGS = Object.freeze({ fps_max: '0.000000' });
