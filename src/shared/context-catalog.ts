import contextData from '../../data/context-catalog.json';
import type { Catalog } from './types';

/** Static values and definitions, never observed possession or ability ranks. */
export type SourceScalar = number | string | null;
export interface ContextProperty {
  name: string;
  label: string | null;
  normalValue: SourceScalar;
  streetBrawlValue: SourceScalar;
  effectiveValue: SourceScalar;
  modeOverride: boolean;
  numericValue: number | null;
  unit: 'percent' | 'seconds' | 'meters' | 'meters-per-second' | 'source' | null;
  postfix: string | null;
  displayUnits: string | null;
  section: string | null;
  providedPropertyType: string | null;
  usageFlags: string[];
  conditional: string | null;
  negativeAttribute: boolean;
  requiredUpgradeBits: string[];
  /** Source formula metadata; numericValue is a base parameter, not its evaluation. */
  scale: Record<string, unknown> | null;
  cssClass: string | null;
  sourcePointer: string;
}
export interface ContextPropertyUpgrade {
  name: string;
  bonus: SourceScalar;
  numericBonus: number | null;
  unit: ContextProperty['unit'];
  /** Null means unspecified in source, not a verified additive operator. */
  upgradeType: string | null;
  scaleStatFilter: string | null;
  sourcePointer: string;
}
export interface ContextUpgradeDefinition {
  index: number;
  /** Ability tier 1..3. Item upgrade arrays do not establish a runtime level. */
  tier: number | null;
  description: string | null;
  properties: ContextPropertyUpgrade[];
}
export interface ContextAbility {
  id: string;
  numericId: string;
  heroId: string;
  slot: 0 | 1 | 2 | 3;
  sourceSlot: 'signature1' | 'signature2' | 'signature3' | 'signature4';
  name: string;
  description: string;
  summary: string;
  iconFile: string;
  imageUrl: string;
  startTrainedDefinition: boolean | null;
  abilityType: string | null;
  /** Separate static unlock resources; neither field proves runtime affordability. */
  unlockDefinition: { abilityPointsCost: number | null; abilityUnlocksCost: number | null; sourcePointer: string } | null;
  behaviours: string[];
  /** Explicit UI property keys such as StatusEffectSleep, not invented weights. */
  importantProperties: string[];
  properties: ContextProperty[];
  upgrades: ContextUpgradeDefinition[];
  tooltipSections: { text: string; requiredPropertyUpgrade: string | null }[];
  sourcePointer: string;
}
export interface ContextHero {
  id: string;
  numericId: string;
  name: string;
  role: string;
  playstyle: string;
  tags: string[];
  portraits: { role: 'hero-card' | 'hero-small' | 'hero-vertical'; file: string; sourceUrl: string }[];
  abilityIds: [string, string, string, string];
  startingStats: { name: string; value: SourceScalar; displayStatName: string | null }[];
  standardLevelUpProperties: { name: string; value: SourceScalar }[];
  scalingStats: { stat: string; scalingStat: string | null; scale: SourceScalar; sourcePointer: string }[];
  weaponId: string | null;
  weapon: { id: string; numericId: string; bulletDamage: number | null; cycleTime: number | null; bullets: number | null; burstShotCount: number | null; clipSize: number | null; reloadDuration: number | null; damagePerSecond: number | null; damagePerSecondWithReload: number | null; shotsPerSecond: number | null; ratesAreProviderDerived: true; sourcePointer: string } | null;
  sourcePointer: string;
}
export interface ContextItem {
  id: string;
  numericId: string;
  name: string;
  category: string;
  tier: number | null;
  tags: string[];
  description: string;
  /** Relative to the existing offline reader-icons cache. */
  iconFile: string;
  active: boolean | null;
  properties: ContextProperty[];
  upgrades: ContextUpgradeDefinition[];
  /** Source shop recipe references; no Street Brawl replacement inference. */
  componentIds: string[];
  unresolvedComponentIds: string[];
  tooltipSections: { kind: string; text: string }[];
  corruptedProperties: ContextPropertyUpgrade[];
  corruptedExcludedPenalties: string[];
  sourcePointer: string;
}
export interface ContextHudGlyph {
  id: 'ability-upgrade-check' | 'ability-pip' | 'ability-pip-empty' | 'ap-icon' | 'spectator-icon';
  file: string;
  sourceUrl: string;
  sourceFile: string;
  sourceSha256: string;
  sourcePointer: string;
  exportFile: string;
  exportSha256: string;
  bytes: number;
  width: number;
  height: number;
  extractedAt: string;
}
export interface ContextCatalog {
  schemaVersion: 1;
  clientVersion: string;
  revision: string;
  catalogSha256: string;
  sourceArchive: string;
  sources: { name: string; file: string; sha256: string; url: string }[];
  heroes: ContextHero[];
  abilities: ContextAbility[];
  items: ContextItem[];
  /** Exact static client symbols, never proof of purchased ranks by themselves. */
  hudGlyphs: ContextHudGlyph[];
  streetBrawl: { scoreToWin: number; abilityPointsPerRound: number[]; draftChoicesPerRound: number[]; ultimateUnlockRoundDefinition: number | null; abilityUpgradeTierCosts: [number, number, number] | null };
  researchEvidence: { id: string; sourceFile: string; mode: string; grain: string; minUnixTimestamp: number | null; maxUnixTimestamp: number | null; clientVersion: string | null; status: 'descriptive-only' | 'excluded'; limitations: string[] }[];
  limitations: string[];
}

export const CONTEXT_CATALOG = contextData as unknown as ContextCatalog;
export const contextCatalog = CONTEXT_CATALOG;

/** Version equality authorizes matching definitions, not runtime observation. */
export function contextCatalogCompatible(catalog: Pick<Catalog, 'clientVersion' | 'revision'>, context: ContextCatalog = CONTEXT_CATALOG): boolean {
  return context.schemaVersion === 1 && catalog.clientVersion === context.clientVersion && catalog.revision === context.revision;
}
