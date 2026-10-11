import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseKv, scalarMap, patchKv, sha256, PROFILES, LEGACY_VIDEO_KEYS, MACHINE_SETTINGS, settingValuesEqual } from '../tools/config-core.mjs';
import { commitFiles } from '../tools/transaction.mjs';

test('KV comments, escaped quoted strings and nested AppState are handled without flattening objects', () => {
  const source = '"AppState" { "buildid" "25689475" // comment with } and "fake"\n "InstalledDepots" {"1" {"manifest" "2"}} "installdir" "Deadlock" }';
  assert.throws(() => scalarMap(source, ['AppState']), /nested/);
  assert.deepEqual(scalarMap(source, ['AppState'], { allowNested: true }), { buildid: ['25689475'], installdir: ['Deadlock'] });
  assert.equal(parseKv('"root" {"label" "a \\"quoted\\" value"}')[0].children[0].value, 'a "quoted" value');
});

test('malformed or duplicate root objects are rejected', () => {
  for (const source of ['"root" {"a"}', '"root" {"a" "b"', '}']) assert.throws(() => parseKv(source));
  assert.throws(() => scalarMap('"root" {} "root" {}', ['root']), /one object/);
});

test('patch is idempotent, removes duplicate overrides and preserves accessibility, display and comments', () => {
  const original = '\uFEFF"video.cfg"\r\n{\r\n\t// keep this\r\n\t"Version" "20"\r\n\t"setting.defaultres" "1920"\r\n\t"setting.r_light_sensitivity_mode" "true"\r\n\t"setting.r_particle_max_detail_level" "0"\r\n\t"setting.r_particle_max_detail_level" "0"\r\n\t"setting.r_citadel_upscaling" "2"\r\n}\r\n';
  for (const profile of Object.values(PROFILES)) {
    const first = patchKv(original, ['video.cfg'], profile.video, LEGACY_VIDEO_KEYS);
    const second = patchKv(first.content, ['video.cfg'], profile.video, LEGACY_VIDEO_KEYS);
    assert.equal(second.content, first.content);
    assert.equal(second.changes.length, 0);
    assert.ok(first.content.startsWith('\uFEFF'));
    assert.ok(first.content.includes('// keep this\r\n'));
    const map = scalarMap(first.content, ['video.cfg']);
    assert.deepEqual(map['setting.defaultres'], ['1920']);
    assert.deepEqual(map['setting.r_light_sensitivity_mode'], ['true']);
    assert.ok(!('setting.r_particle_max_detail_level' in map));
  }
});

test('machine patch touches only explicit performance keys and preserves input/audio/network settings', () => {
  const original = '"config"\n{\n "convars"\n {\n "fps_max" "400"\n "fps_max_ui" "120"\n "snd_mixahead" "0.001000"\n "rate" "196608"\n "citadel_crosshair_dot_size" "4.0"\n }\n}\n';
  const result = patchKv(original, ['config', 'convars'], MACHINE_SETTINGS);
  const after = scalarMap(result.content, ['config', 'convars']);
  assert.deepEqual(after.fps_max, ['0.000000']);
  for (const key of ['fps_max_ui', 'snd_mixahead', 'rate', 'citadel_crosshair_dot_size']) assert.deepEqual(after[key], scalarMap(original, ['config', 'convars'])[key]);
  assert.deepEqual(result.changes.map((change) => change.key), ['fps_max']);
});

test('planned comparisons isolate a single declared graphics variable', () => {
  const differingKeys = (left, right) => [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => left[key] !== right[key]).sort();
  const control = PROFILES.fsr1control.video;
  for (const [profile, key] of [
    ['fpsfirst', 'setting.mat_viewportscale'],
    ['fsr160', 'setting.mat_viewportscale'],
    ['stretch80', 'setting.r_citadel_upscaling'],
    ['fsr1fxaa', 'setting.r_citadel_antialiasing'],
    ['throughput80', 'setting.r_low_latency'],
  ]) assert.deepEqual(differingKeys(control, PROFILES[profile].video), [key]);
  for (const profile of ['stretch67', 'fsr2equal67', 'fsr3equal67']) {
    assert.deepEqual(differingKeys(PROFILES.fpsfirst.video, PROFILES[profile].video), ['setting.r_citadel_upscaling']);
  }
  assert.deepEqual(Object.keys(MACHINE_SETTINGS), ['fps_max']);
  for (const profile of Object.values(PROFILES)) {
    assert.ok(!Object.keys(profile.video).some((key) => /ragdoll|tracer|thread_pool|affinity|drop_shadow|barnlight/.test(key)));
  }
});

test('game-serialized zero FPS cap remains correct without rewriting the settings file', () => {
  for (const serialized of ['0', '0.000000', '-0', '0e0']) {
    const original = `"config" { "convars" { "fps_max" "${serialized}" "fps_max_ui" "120" } }`;
    const result = patchKv(original, ['config', 'convars'], MACHINE_SETTINGS);
    assert.equal(result.content, original);
    assert.deepEqual(result.changes, []);
  }
  assert.ok(settingValuesEqual('fps_max', '400', '400.000000'));
  assert.ok(settingValuesEqual('setting.fps_max', '0.0', '0'));
});

test('numeric formatting cannot hide an actual FPS cap or alter unrelated string semantics', () => {
  for (const actual of ['400', '60', '0.000001', '', 'false', 'NaN', 'Infinity', '0x0']) {
    assert.equal(settingValuesEqual('fps_max', actual, '0.000000'), false);
  }
  assert.equal(settingValuesEqual('unrelated', '0', '0.000000'), false);
  const result = patchKv('"config" { "convars" { "fps_max" "400" } }', ['config', 'convars'], MACHINE_SETTINGS);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(scalarMap(result.content, ['config', 'convars']).fps_max, ['0.000000']);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deadlock-fps-test-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    if (path.dirname(target).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !path.basename(target).startsWith('deadlock-fps-test-')) throw new Error('Unexpected test cleanup directory');
    fs.rmSync(target, { recursive: true, force: true });
  });
  const files = ['video.txt', 'machine_convars.vcfg'].map((name, index) => {
    const target = path.join(root, name);
    const before = Buffer.from(`original ${index}`);
    const content = Buffer.from(`candidate ${index}`);
    fs.writeFileSync(target, before);
    return { name, target, beforeHash: sha256(before), afterHash: sha256(content), content };
  });
  return { root, files, backupRoot: path.join(root, 'backups') };
}

test('transaction saves byte-exact verified originals before installing both files', (t) => {
  const { root, files, backupRoot } = fixture(t);
  const result = commitFiles(files, backupRoot, () => {}, { testFixture: true });
  assert.equal(result.manifest.status, 'applied');
  for (const file of files) {
    assert.equal(sha256(fs.readFileSync(file.target)), file.afterHash);
    assert.equal(sha256(fs.readFileSync(path.join(result.backupDirectory, file.name))), file.beforeHash);
  }
  assert.ok(!fs.readdirSync(root).some((name) => name.endsWith('.tmp')));
});

test('changed settings invalidate a staged transaction before mutation', (t) => {
  const { files, backupRoot } = fixture(t);
  fs.writeFileSync(files[1].target, 'Cloud save');
  assert.throws(() => commitFiles(files, backupRoot, () => {}, {}), /changed since preparation/);
  assert.equal(sha256(fs.readFileSync(files[0].target)), files[0].beforeHash);
  assert.equal(fs.existsSync(backupRoot), false);
});

test('write failure after first replacement rolls back while game remains closed', (t) => {
  const { files, backupRoot } = fixture(t);
  assert.throws(() => commitFiles(files, backupRoot, () => {}, {}, { beforeWrite(index) { if (index === 1) throw new Error('disk unavailable'); } }), /disk unavailable/);
  for (const file of files) assert.equal(sha256(fs.readFileSync(file.target)), file.beforeHash);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, fs.readdirSync(backupRoot)[0], 'manifest.json')));
  assert.equal(manifest.rollback[0].restored, true);
});

test('game starting mid-transaction prevents further writes including rollback', (t) => {
  const { files, backupRoot } = fixture(t);
  let gameRunning = false;
  const guard = () => { if (gameRunning) throw new Error('game running'); };
  assert.throws(() => commitFiles(files, backupRoot, guard, {}, { beforeWrite(index) { if (index === 1) gameRunning = true; } }), /game running/);
  assert.equal(sha256(fs.readFileSync(files[0].target)), files[0].afterHash);
  assert.equal(sha256(fs.readFileSync(files[1].target)), files[1].beforeHash);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, fs.readdirSync(backupRoot)[0], 'manifest.json')));
  assert.equal(manifest.rollback[0].restored, false);
  assert.equal(sha256(fs.readFileSync(path.join(backupRoot, fs.readdirSync(backupRoot)[0], files[0].name))), files[0].beforeHash);
});

test('a tampered backup is refused before rollback can overwrite the candidate', (t) => {
  const { files, backupRoot } = fixture(t);
  assert.throws(() => commitFiles(files, backupRoot, () => {}, {}, { beforeWrite(index) {
    if (index === 1) {
      const directory = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
      fs.writeFileSync(path.join(directory, files[0].name), 'bad backup');
      throw new Error('second write refused');
    }
  } }), /second write refused/);
  assert.equal(sha256(fs.readFileSync(files[0].target)), files[0].afterHash);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, fs.readdirSync(backupRoot)[0], 'manifest.json')));
  assert.match(manifest.rollback[0].error, /Backup changed/);
});

test('unsafe nonfile targets are rejected before backups or writes', (t) => {
  const { root, files, backupRoot } = fixture(t);
  files[0].target = root;
  assert.throws(() => commitFiles(files, backupRoot, () => {}, {}), /regular file/);
  assert.equal(fs.existsSync(backupRoot), false);
});
