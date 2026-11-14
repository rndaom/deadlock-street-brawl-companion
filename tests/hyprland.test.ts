import { describe, expect, it } from 'vitest';
import { monitorFor, overlayRuleLua, parseMonitors, sharedMonitorScale } from '../electron/hyprland';

const portrait = { name: 'DP-2', bounds: { x: -1080, y: -420, width: 1080, height: 1920 } };

describe('Hyprland overlay placement rule', () => {
  it('floats, pins and unfocuses the overlay at the game rectangle', () => {
    const lua = overlayRuleLua('Street Brawl overlay', { x: -1019.6, y: 100, width: 960, height: 540 }, portrait);
    expect(lua).toContain('match = { title = "^Street Brawl overlay$" }');
    expect(lua).toContain('float = true, pin = true, no_initial_focus = true, no_focus = true');
    // Rule positions are relative to the named monitor.
    expect(lua).toContain('monitor = "DP-2", move = "60 520", size = "960 540"');
    // Re-registering replaces the previous rule instead of stacking rules.
    expect(lua.startsWith('if _G.streetBrawlOverlayRule then _G.streetBrawlOverlayRule:set_enabled(false) end')).toBe(true);
  });
  it('refuses a title that would need regex or Lua escaping', () => {
    expect(() => overlayRuleLua('a"b', { x: 0, y: 0, width: 1, height: 1 }, portrait)).toThrow();
  });
  it('reads monitors in layout coordinates and finds the one holding the game', () => {
    const monitors = parseMonitors(JSON.stringify([
      { name: 'DP-1', x: 0, y: 0, width: 1920, height: 1080, scale: 1, transform: 0 },
      { name: 'DP-2', x: -1080, y: -420, width: 1920, height: 1080, scale: 1, transform: 1 },
      { name: 'HDMI-A-1', x: 1920, y: 0, width: 3840, height: 2160, scale: 2, transform: 0 },
      { name: 'broken' },
    ]));
    expect(monitors.map(monitor => monitor.name)).toEqual(['DP-1', 'DP-2', 'HDMI-A-1']);
    expect(monitors[1]).toEqual(portrait);
    expect(monitors[2].bounds).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 });
    expect(monitorFor(monitors, { x: -1020, y: 100, width: 960, height: 540 })?.name).toBe('DP-2');
    expect(monitorFor(monitors, { x: 480, y: 270, width: 960, height: 540 })?.name).toBe('DP-1');
    expect(monitorFor(monitors, { x: 9000, y: 0, width: 960, height: 540 })).toBeNull();
    expect(parseMonitors('not json')).toEqual([]);
  });
  it('finds the scale shared by every monitor, if there is one', () => {
    expect(sharedMonitorScale(JSON.stringify([{ name: 'DP-1', scale: 1 }, { name: 'DP-2', scale: 1 }]))).toBe(1);
    expect(sharedMonitorScale(JSON.stringify([{ name: 'DP-1', scale: 1.5 }]))).toBe(1.5);
    expect(sharedMonitorScale(JSON.stringify([{ name: 'DP-1', scale: 1 }, { name: 'HDMI-A-1', scale: 2 }]))).toBeNull();
    expect(sharedMonitorScale('[]')).toBeNull();
    expect(sharedMonitorScale('not json')).toBeNull();
  });
});
