import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import baseCatalogData from '../data/public-catalog.json';
import { CONTEXT_CATALOG, contextCatalogCompatible } from '../src/shared/context-catalog';
import type { Catalog } from '../src/shared/types';

const catalog = baseCatalogData as Catalog;
const root = process.cwd();
const catalogScript = await import(pathToFileURL(path.join(root, 'scripts/sync-context-catalog.mjs')).href);
const iconScript = await import(pathToFileURL(path.join(root, 'scripts/sync-context-icons.mjs')).href);
const glyphScript = await import(pathToFileURL(path.join(root, 'scripts/sync-context-glyphs.mjs')).href);
const temporaryRoots: string[] = [];
async function temporaryData() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deadlock-public-context-test-'));
  temporaryRoots.push(temporary); await fs.mkdir(path.join(temporary, 'data'));
  await fs.copyFile(path.join(root, 'data/public-catalog.json'), path.join(temporary, 'data/public-catalog.json'));
  await fs.copyFile(path.join(root, 'data/catalog-manifest.json'), path.join(temporary, 'data/catalog-manifest.json'));
  return temporary;
}
afterAll(async () => {
  vi.restoreAllMocks();
  for (const temporary of temporaryRoots) {
    const absolute = path.resolve(temporary); const relative = path.relative(path.resolve(os.tmpdir()), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(absolute).startsWith('deadlock-public-context-test-')) throw new Error('Unsafe test cleanup target');
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe('source-backed context definitions', () => {
  it('matches the complete pinned public catalog without adding prerelease heroes', () => {
    expect(contextCatalogCompatible(catalog)).toBe(true);
    expect(CONTEXT_CATALOG.heroes.map(hero => hero.id)).toEqual(catalog.heroes.map(hero => hero.id));
    expect(CONTEXT_CATALOG.items.map(item => item.id)).toEqual(catalog.items.map(item => item.id));
    expect(CONTEXT_CATALOG.abilities).toHaveLength(164);
    expect(CONTEXT_CATALOG.heroes.every(hero => hero.abilityIds.length === 4)).toBe(true);
  });
  it('refuses definitions with either a different client or source revision', () => {
    expect(contextCatalogCompatible({ ...catalog, clientVersion: '6723' })).toBe(false);
    expect(contextCatalogCompatible({ ...catalog, revision: '11059930' })).toBe(false);
  });
  it('has exact canonical four-slot Haze labels, separate from current ranks', () => {
    const hero = CONTEXT_CATALOG.heroes.find(entry => entry.id === 'hero_haze')!;
    expect(hero.abilityIds.map(id => CONTEXT_CATALOG.abilities.find(ability => ability.id === id)!.name))
      .toEqual(['Sleep Dagger', 'Smoke Bomb', 'Fixation', 'Bullet Dance']);
    expect(CONTEXT_CATALOG.abilities.filter(ability => ability.heroId === hero.id).map(ability => ability.slot)).toEqual([0, 1, 2, 3]);
    expect(CONTEXT_CATALOG.abilities.every(ability => !('rank' in ability) && !('unlocked' in ability))).toBe(true);
  });
  it('retains the actual Street Brawl radius override and spirit coefficient of Essence Bomb', () => {
    const ability = CONTEXT_CATALOG.abilities.find(entry => entry.id === 'ability_blood_bomb')!;
    expect(ability.properties.find(property => property.name === 'Radius')).toMatchObject({ normalValue: '7m', streetBrawlValue: '6m', effectiveValue: '6m', numericValue: 6, modeOverride: true, unit: 'meters' });
    expect(ability.properties.find(property => property.name === 'Damage')).toMatchObject({ numericValue: 90, scale: { specific_stat_scale_type: 'ETechPower', stat_scale: 1.22 } });
  });
  it('preserves zero mode overrides and null inheritance distinctly', () => {
    expect(catalogScript.normalizeContextProperty('Damage', { value: '12', street_brawl_value: 0 }, 'fixture')).toMatchObject({ numericValue: 0, effectiveValue: 0, modeOverride: true });
    expect(catalogScript.normalizeContextProperty('Damage', { value: '12', street_brawl_value: null }, 'fixture')).toMatchObject({ numericValue: 12, effectiveValue: '12', modeOverride: false });
    expect(catalogScript.numericScalar('12 + spirit')).toBeNull();
  });
  it('keeps wearer spirit resistance separate from conditional enemy resistance reduction', () => {
    const item = CONTEXT_CATALOG.items.find(entry => entry.id === 'upgrade_escalating_exposure')!;
    expect(item.properties.find(property => property.name === 'TechResist')).toMatchObject({ numericValue: 17, providedPropertyType: 'MODIFIER_VALUE_TECH_RESIST', usageFlags: [] });
    expect(item.properties.find(property => property.name === 'TechArmorDamageReduction')).toMatchObject({ numericValue: -8, providedPropertyType: 'MODIFIER_VALUE_TECH_RESIST_REDUCTION', usageFlags: ['ConditionallyApplied'] });
  });
  it('preserves source item upgrade bonuses without inventing an additive or replacement operator', () => {
    const extra = CONTEXT_CATALOG.items.find(entry => entry.id === 'upgrade_improved_spirit')!;
    const improved = CONTEXT_CATALOG.items.find(entry => entry.id === 'upgrade_soaring_spirit')!;
    expect(extra.properties.find(property => property.name === 'TechPower')?.numericValue).toBe(10);
    expect(extra.upgrades[0]?.properties[0]).toMatchObject({ name: 'TechPower', numericBonus: 10, upgradeType: null });
    expect(improved.properties.find(property => property.name === 'TechPower')?.numericValue).toBe(18);
    expect(improved.upgrades[0]?.properties.find(property => property.name === 'TechPower')?.numericBonus).toBe(22);
    expect(improved.componentIds).toEqual(['upgrade_improved_spirit']);
    expect(improved.upgrades[0]?.tier).toBeNull();
  });
  it('retains scaling, explicit scale operators, and required upgrade bits for the advisor', () => {
    const upgraded = CONTEXT_CATALOG.abilities.flatMap(ability => ability.upgrades.flatMap(upgrade => upgrade.properties));
    expect(upgraded.some(property => property.upgradeType === 'EAddToScale' && property.scaleStatFilter === 'ETechPower')).toBe(true);
    expect(CONTEXT_CATALOG.abilities.flatMap(ability => ability.properties).some(property => property.requiredUpgradeBits.length > 0)).toBe(true);
    const leech = CONTEXT_CATALOG.items.find(item => item.id === 'upgrade_damage_recycler')!;
    expect(leech.properties.find(property => property.name === 'AbilityLifestealPercentHero')).toMatchObject({ numericValue: 28, scale: { specific_stat_scale_type: 'EHealingOutput' } });
  });
  it('preserves static gun baselines and hero spirit scaling without claiming measured damage', () => {
    const haze = CONTEXT_CATALOG.heroes.find(hero => hero.id === 'hero_haze')!;
    expect(haze.weapon).toMatchObject({ bulletDamage: 5.26, cycleTime: 0.105, bullets: 1, clipSize: 25, ratesAreProviderDerived: true });
    expect(haze.weapon?.damagePerSecond).toBeCloseTo(50.095238);
    expect(haze.scalingStats).toContainEqual(expect.objectContaining({ stat: 'EClipSize', scalingStat: 'ETechPower', scale: 0.5 }));
  });
  it('pins separate unlock resource definitions but leaves unproven tier prices unknown', () => {
    expect(CONTEXT_CATALOG.abilities.every(ability => ability.unlockDefinition?.abilityPointsCost === 0 && ability.unlockDefinition.abilityUnlocksCost === 1)).toBe(true);
    expect(CONTEXT_CATALOG.streetBrawl.abilityUpgradeTierCosts).toBeNull();
    expect(CONTEXT_CATALOG.streetBrawl.abilityPointsPerRound).toEqual([6, 6, 5, 5, 10]);
  });
  it('retains historical research limits and excludes the unresolved prerelease window', () => {
    expect(CONTEXT_CATALOG.researchEvidence.find(evidence => evidence.id === 'saved-pre-rat-window')?.status).toBe('excluded');
    expect(CONTEXT_CATALOG.researchEvidence.every(evidence => evidence.clientVersion === null && !('winRate' in evidence))).toBe(true);
    expect(CONTEXT_CATALOG.researchEvidence.find(evidence => evidence.id === 'saved-paige-rat-items')?.limitations.join(' ')).toMatch(/71 was incorrectly identified as Graves/);
  });
});

describe('offline provenance and cached image integrity', () => {
  it('rebuilds exact definitions and validates all public PNGs with network access disabled', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network disabled in offline integrity test'));
    expect(await catalogScript.verifyContextCatalog(root)).toMatchObject({ heroes: 41, abilities: 164, items: 173, clientVersion: '6774', revision: '11112755' });
    expect(await iconScript.verifyContextIcons(root)).toMatchObject({ images: 292, clientVersion: '6774', revision: '11112755' });
    expect((await glyphScript.verifyStaticContextGlyphs(root)).manifest.glyphs).toHaveLength(5);
    expect(fetch).not.toHaveBeenCalled(); fetch.mockRestore();
  });
  it('maps all released heroes to three local portrait variants and all signature slots to PNGs', () => {
    const expected = iconScript.expectedContextAssets(CONTEXT_CATALOG) as { role: string; heroId: string; slot?: number; file: string }[];
    expect(expected).toHaveLength(292);
    for (const hero of CONTEXT_CATALOG.heroes) {
      expect(expected.filter(asset => asset.heroId === hero.id && asset.role !== 'ability').map(asset => asset.role)).toEqual(['hero-card', 'hero-small', 'hero-vertical']);
      expect(expected.filter(asset => asset.heroId === hero.id && asset.role === 'ability').map(asset => asset.slot)).toEqual([0, 1, 2, 3]);
    }
    expect(expected.every(asset => /^(heroes|abilities|glyphs)\/[a-zA-Z0-9_-]+\.png$/.test(asset.file))).toBe(true);
  });
  it('binds exact HUD symbols to static resource hashes with separate paid/empty templates', () => {
    expect(CONTEXT_CATALOG.hudGlyphs.map(glyph => [glyph.id, glyph.width, glyph.height])).toEqual([
      ['ability-upgrade-check', 64, 64], ['ability-pip', 32, 32], ['ability-pip-empty', 32, 32], ['ap-icon', 51, 51], ['spectator-icon', 24, 24],
    ]);
    expect(CONTEXT_CATALOG.hudGlyphs.every(glyph => glyph.sourceUrl.startsWith('valve-resource://6745/') && /^[a-f0-9]{64}$/.test(glyph.sourceSha256) && /^[a-f0-9]{64}$/.test(glyph.exportSha256))).toBe(true);
    const assets = iconScript.expectedContextAssets(CONTEXT_CATALOG) as { role: string; id: string; sourceUrl: string }[];
    expect(assets.filter(asset => asset.role === 'hud-glyph').map(asset => asset.id)).toEqual(CONTEXT_CATALOG.hudGlyphs.map(glyph => glyph.id));
  });
  it('generates lightweight renderer labels from exact hero signature IDs without stats or inferred state', async () => {
    const labels = catalogScript.buildAbilityLabels(CONTEXT_CATALOG);
    expect(labels.clientVersion).toBe('6774'); expect(labels.revision).toBe('11112755');
    expect(labels.abilities).toHaveLength(164);
    expect(Object.keys(labels.abilities[0])).toEqual(['id', 'numericId', 'heroId', 'slot', 'name']);
    expect(await fs.readFile(path.join(root, 'src/renderer/ability-labels.json'), 'utf8')).toBe(`${JSON.stringify(labels, null, 2)}\n`);
  });
  it('rejects static raw-resource corruption independently of decoded PNGs', async () => {
    const temporary = await temporaryData(); const archive = 'context-sources/installed-client-6745-11078118';
    await fs.cp(path.join(root, 'data', archive), path.join(temporary, 'data', archive), { recursive: true });
    await fs.writeFile(path.join(temporary, 'data', archive, 'raw/ability_upgrade_check_psd.vtex_c'), Buffer.from('altered static resource'));
    await expect(glyphScript.verifyStaticContextGlyphs(temporary)).rejects.toThrow(/Static glyph source integrity failure/);
  });
  it('rejects decoded static PNG corruption without requiring the installed game or decoder', async () => {
    const temporary = await temporaryData(); const archive = 'context-sources/installed-client-6745-11078118';
    await fs.cp(path.join(root, 'data', archive), path.join(temporary, 'data', archive), { recursive: true });
    const file = path.join(temporary, 'data', archive, 'exports/ap.png'); const bytes = await fs.readFile(file); bytes[bytes.length - 1] ^= 1; await fs.writeFile(file, bytes);
    await expect(glyphScript.verifyStaticContextGlyphs(temporary)).rejects.toThrow(/Static glyph PNG integrity failure/);
  });
  it('refuses public catalog tampering before loading dependent sources', async () => {
    const temporary = await temporaryData(); await fs.writeFile(path.join(temporary, 'data/public-catalog.json'), '{}');
    await expect(catalogScript.readPinnedContextInputs(temporary)).rejects.toThrow(/Public catalog integrity failure/);
  });
  it('refuses traversal in a locally corrupted provenance envelope', async () => {
    const temporary = await temporaryData(); const manifest = JSON.parse(await fs.readFile(path.join(temporary, 'data/catalog-manifest.json'), 'utf8'));
    manifest.sourceArchive = '../outside'; await fs.writeFile(path.join(temporary, 'data/catalog-manifest.json'), JSON.stringify(manifest));
    await expect(catalogScript.readPinnedContextInputs(temporary)).rejects.toThrow(/Unsafe source archive/);
  });
  it('refuses a pinned raw-source hash mismatch before treating its content as data', async () => {
    const temporary = await temporaryData(); const manifest = JSON.parse(await fs.readFile(path.join(temporary, 'data/catalog-manifest.json'), 'utf8'));
    const sourceDirectory = path.join(temporary, 'data', manifest.sourceArchive); await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.copyFile(path.join(root, 'data', manifest.sourceArchive, 'steam-info.json'), path.join(sourceDirectory, 'steam-info.json'));
    await fs.writeFile(path.join(sourceDirectory, 'items.json'), '[]');
    await expect(catalogScript.readPinnedContextInputs(temporary)).rejects.toThrow(/Pinned items source integrity failure/);
  });
  it('rejects unsupported image headers or dimension bombs', async () => {
    const bytes = await fs.readFile(path.join(root, 'assets/context-icons/heroes/hero_haze--small.png'));
    expect(iconScript.contextPngMetadata(bytes)).toMatchObject({ width: 128, height: 128 });
    const altered = Buffer.from(bytes); altered.writeUInt32BE(100000, 16);
    expect(() => iconScript.contextPngMetadata(altered)).toThrow(/dimensions/);
    expect(() => iconScript.contextPngMetadata(Buffer.from('not an image'))).toThrow(/Invalid context PNG/);
  });
});
