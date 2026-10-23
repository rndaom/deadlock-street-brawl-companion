import type { AppMode, AppSettings } from './types';
export const DEFAULT_SETTINGS: AppSettings = {
  textScale: 1, hidePlayerNames: true, alwaysOnTop: false, displayId: null, overlay: true,
};

export function validateSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object.');
  const allowed = new Set(['textScale', 'hidePlayerNames', 'alwaysOnTop', 'displayId', 'overlay']);
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error('Unknown setting.');
  if ('textScale' in input && (typeof input.textScale !== 'number' || !Number.isFinite(input.textScale) || input.textScale < 0.8 || input.textScale > 1.5)) throw new Error('Text size must be between 0.8 and 1.5.');
  for (const key of ['hidePlayerNames', 'alwaysOnTop', 'overlay']) {
    if (key in input && typeof input[key] !== 'boolean') throw new Error('Setting must be a boolean.');
  }
  if ('displayId' in input && input.displayId !== null && (typeof input.displayId !== 'string' || input.displayId.length > 100 || input.displayId.length === 0)) throw new Error('Invalid display.');
  return { ...input } as Partial<AppSettings>;
}

export function isAppMode(value: unknown): value is AppMode { return value === 'live'; }
