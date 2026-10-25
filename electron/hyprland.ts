import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ScreenRect { x: number; y: number; width: number; height: number }

/** Hyprland's IPC socket when the companion runs inside a Hyprland session, otherwise null. */
export function hyprlandSocket(env: NodeJS.ProcessEnv = process.env): string | null {
  const runtime = env.XDG_RUNTIME_DIR;
  const instance = env.HYPRLAND_INSTANCE_SIGNATURE;
  if (!runtime || !instance || /[/\\]/.test(instance)) return null;
  const path = join(runtime, 'hypr', instance, '.socket.sock');
  return existsSync(path) ? path : null;
}

/** One request on Hyprland's request socket; the compositor closes the connection after its reply. */
export function hyprlandRequest(socket: string, command: string, timeoutMs = 1_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const client = connect(socket);
    const timer = setTimeout(() => { client.destroy(); reject(new Error('hyprland_timeout')); }, timeoutMs);
    client.once('connect', () => client.write(command));
    client.on('data', (chunk: Buffer) => chunks.push(chunk));
    client.once('error', error => { clearTimeout(timer); reject(error); });
    client.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

const integer = (value: number) => Math.round(Number.isFinite(value) ? value : 0);

export interface HyprlandMonitor { name: string; bounds: ScreenRect }

/** Monitors from `j/monitors` in layout coordinates: logical (scaled) size, rotated for 90/270 degree transforms. */
export function parseMonitors(json: string): HyprlandMonitor[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const monitors: HyprlandMonitor[] = [];
  for (const entry of parsed as Record<string, unknown>[]) {
    const { name, x, y, width, height } = entry ?? {};
    if (typeof name !== 'string' || ![x, y, width, height].every(value => typeof value === 'number' && Number.isFinite(value))) continue;
    const scale = typeof entry.scale === 'number' && entry.scale > 0 ? entry.scale : 1;
    const rotated = typeof entry.transform === 'number' && entry.transform % 2 === 1;
    const [w, h] = rotated ? [height as number, width as number] : [width as number, height as number];
    monitors.push({ name, bounds: { x: x as number, y: y as number, width: Math.round(w / scale), height: Math.round(h / scale) } });
  }
  return monitors;
}

/** The monitor holding the rectangle's centre, which is the monitor the game client is on. */
export function monitorFor(monitors: HyprlandMonitor[], bounds: ScreenRect): HyprlandMonitor | null {
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  return monitors.find(({ bounds: m }) => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ?? null;
}

/**
 * Lua for a runtime-only window rule (Hyprland 0.55+ Lua configuration; it is gone after the next config
 * reload). Wayland clients cannot place, raise or unfocus their own windows, so the compositor is asked to
 * open the overlay floating, pinned, unfocusable and undecorated at exactly the game client's rectangle.
 * Rules apply when a window maps, so a moved game needs the overlay window recreated. A rule's `move` is
 * relative to the monitor the window opens on, so the rule names the game's monitor and offsets from it.
 */
export function overlayRuleLua(title: string, bounds: ScreenRect, monitor: HyprlandMonitor): string {
  // The title is a regex inside a Lua string; plain words need neither regex nor Lua escaping.
  if (!/^[A-Za-z0-9 ]+$/.test(title)) throw new Error('overlay_title');
  const pattern = `^${title}$`;
  const x = integer(bounds.x - monitor.bounds.x), y = integer(bounds.y - monitor.bounds.y);
  return [
    'if _G.streetBrawlOverlayRule then _G.streetBrawlOverlayRule:set_enabled(false) end',
    `_G.streetBrawlOverlayRule = hl.window_rule({ name = "street-brawl-overlay", match = { title = ${JSON.stringify(pattern)} },`,
    '  float = true, pin = true, no_initial_focus = true, no_focus = true, no_follow_mouse = true,',
    '  no_shadow = true, no_anim = true, no_blur = true, no_dim = true, border_size = 0, decorate = false,',
    `  monitor = ${JSON.stringify(monitor.name)}, move = "${x} ${y}", size = "${integer(bounds.width)} ${integer(bounds.height)}" })`,
  ].join('\n');
}

/** Registers the overlay placement rule; false when this is not a Hyprland session that accepts it. */
export async function placeOverlay(title: string, bounds: ScreenRect, socket = hyprlandSocket()): Promise<boolean> {
  if (!socket) return false;
  try {
    const monitor = monitorFor(parseMonitors(await hyprlandRequest(socket, 'j/monitors')), bounds);
    if (!monitor) return false;
    return (await hyprlandRequest(socket, `eval ${overlayRuleLua(title, bounds, monitor)}`)).trim() === 'ok';
  }
  catch { return false; }
}
