// Read-only integrity check of the unsigned Windows directory build.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { extractFile } from '@electron/asar';

const root = fileURLToPath(new URL('../', import.meta.url));
const resources = path.join(root, 'release/win-unpacked/resources');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const packed = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json').toString('utf8'));
if (packed.version !== expected.version) throw new Error('Packaged application version does not match source.');
const native = await fs.readFile(path.join(root, 'native/ScreenReader/publish/ScreenReader.exe'));
const packagedNative = await fs.readFile(path.join(resources, 'screen-reader/ScreenReader.exe'));
if (digest(native) !== digest(packagedNative)) throw new Error('Packaged native reader differs from the tested helper.');
const manifest = JSON.parse(await fs.readFile(path.join(resources, 'reader-icons/manifest.json'), 'utf8'));
const sourceManifest = JSON.parse(await fs.readFile(path.join(root, 'assets/reader-icons/manifest.json'), 'utf8'));
if (manifest.icons.length !== 173 || manifest.catalogSha256 !== sourceManifest.catalogSha256) throw new Error('Packaged icon manifest is incomplete or mismatched.');
for (const icon of manifest.icons) {
  const iconPath = path.resolve(resources, 'reader-icons', icon.file);
  const iconRoot = path.resolve(resources, 'reader-icons') + path.sep;
  if (!iconPath.startsWith(iconRoot) || digest(await fs.readFile(iconPath)) !== icon.sha256) throw new Error('Packaged icon integrity check failed.');
}
const contextManifest = JSON.parse(await fs.readFile(path.join(resources, 'context-icons/manifest.json'), 'utf8'));
const sourceContext = JSON.parse(await fs.readFile(path.join(root, 'assets/context-icons/manifest.json'), 'utf8'));
const catalogBytes = await fs.readFile(path.join(root, 'data/public-catalog.json'));
const contextBytes = await fs.readFile(path.join(root, 'data/context-catalog.json'));
if (contextManifest.assets.length !== 278 || contextManifest.catalogSha256 !== digest(catalogBytes)
  || contextManifest.contextCatalogSha256 !== digest(contextBytes)
  || JSON.stringify(contextManifest) !== JSON.stringify(sourceContext)) throw new Error('Packaged context definitions/templates are incomplete or mismatched.');
const roles = Object.fromEntries(['hero-card', 'hero-small', 'hero-vertical', 'ability', 'hud-glyph'].map(role =>
  [role, contextManifest.assets.filter(asset => asset.role === role).length]));
if (roles['hero-card'] !== 39 || roles['hero-small'] !== 39 || roles['hero-vertical'] !== 39
  || roles.ability !== 156 || roles['hud-glyph'] !== 5) throw new Error('Packaged context template coverage is incomplete.');
const contextRoot = path.resolve(resources, 'context-icons') + path.sep;
const seen = new Set();
for (const asset of contextManifest.assets) {
  if (!/^(?:heroes|abilities|glyphs)\/[A-Za-z0-9_-]+\.png$/.test(asset.file) || seen.has(asset.file)) throw new Error('Invalid packaged context image path.');
  seen.add(asset.file);
  const imagePath = path.resolve(contextRoot, asset.file);
  const bytes = await fs.readFile(imagePath);
  if (!imagePath.startsWith(contextRoot) || digest(bytes) !== asset.sha256 || bytes.length !== asset.bytes) throw new Error('Packaged context image integrity check failed.');
}
const descriptors = [];
for (const [directory, name] of [['context-icons', 'templates'], ['reader-icons', 'context-templates']]) {
  const metadataBytes = await fs.readFile(path.join(resources, directory, `${name}.json`));
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const binary = await fs.readFile(path.join(resources, directory, `${name}.bin`));
  const originalBinary = await fs.readFile(path.join(root, 'assets', directory, `${name}.bin`));
  const manifestBytes = await fs.readFile(path.join(resources, directory, 'manifest.json'));
  if (metadata.schemaVersion !== 1 || metadata.algorithmVersion !== 2 || metadata.grid !== 12 || !Number.isInteger(metadata.templateCount)
    || metadata.templateCount < 1 || metadata.templateCount > 1024 || binary.length < 16 || binary.length > 4_000_000
    || binary.toString('ascii', 0, 8) !== 'DLDESC01' || binary.readInt32LE(8) !== 12 || binary.readInt32LE(12) !== metadata.templateCount
    || digest(binary) !== metadata.binarySha256 || digest(binary) !== digest(originalBinary)
    || digest(manifestBytes) !== metadata.manifestSha256) throw new Error('Packaged static descriptor cache failed integrity checks.');
  descriptors.push({ directory, algorithmVersion: metadata.algorithmVersion, templateCount: metadata.templateCount, bytes: binary.length, sha256: digest(binary) });
}
const report = {
  schemaVersion: 1, applicationVersion: packed.version, passed: true, unsigned: true,
  nativeReaderSha256: digest(packagedNative), nativeReaderBytes: packagedNative.length,
  packagedIconsVerified: manifest.icons.length, catalogSha256: manifest.catalogSha256,
  packagedContextAssetsVerified: contextManifest.assets.length, contextAssetRoles: roles,
  contextCatalogSha256: contextManifest.contextCatalogSha256,
  staticDescriptorCaches: descriptors,
};
await fs.writeFile(path.join(root, 'artifacts/package-verification.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report) + '\n');
