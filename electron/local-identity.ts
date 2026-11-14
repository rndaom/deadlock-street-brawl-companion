import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_VDF_BYTES = 128 * 1024;
const STEAM_INDIVIDUAL_BASE = 76561197960265728n;
type VdfObject = Map<string, string | VdfObject>;

/** Strict Valve KeyValues text: keys are lower-cased; duplicates, nesting over 4 levels or malformed input give null. */
function parseVdf(source: string): VdfObject | null {
  if (Buffer.byteLength(source, 'utf8') > MAX_VDF_BYTES) return null;
  const tokens: string[] = [];
  const pattern = /\s+|\/\/[^\r\n]*|"((?:\\.|[^"\\])*)"|[{}]/gy;
  let position = 0;
  while (position < source.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) return null;
    position = pattern.lastIndex;
    if (match[0].trim().length === 0 || match[0].startsWith('//')) continue;
    const token = match[1] === undefined ? match[0] : match[1].replace(/\\([\\"])/g, '$1');
    if (token.includes('\0') || token.length > 512 || tokens.length > 4096) return null;
    tokens.push(token);
  }
  let index = 0;
  function object(depth: number, nested: boolean): VdfObject | null {
    if (depth > 4) return null;
    const output: VdfObject = new Map();
    while (index < tokens.length) {
      const key = tokens[index++];
      if (key === '}') return nested ? output : null;
      if (key === '{' || index >= tokens.length || output.has(key.toLowerCase())) return null;
      const value = tokens[index++];
      if (value === '}') return null;
      if (value === '{') {
        const child = object(depth + 1, true);
        if (!child) return null;
        output.set(key.toLowerCase(), child);
      } else output.set(key.toLowerCase(), value);
    }
    return nested ? null : output;
  }
  const parsed = object(0, false);
  return parsed && index === tokens.length ? parsed : null;
}

/** Read only the active account's public display name; no credentials or IDs leave this module. */
export function steamDisplayNamesFromVdf(source: string, activeAccountId: number): string[] {
  if (!Number.isSafeInteger(activeAccountId) || activeAccountId <= 0 || activeAccountId > 0xffffffff) return [];
  const users = parseVdf(source)?.get('users');
  if (!(users instanceof Map)) return [];
  const account = users.get(String(STEAM_INDIVIDUAL_BASE + BigInt(activeAccountId)));
  if (!(account instanceof Map)) return [];
  const name = account.get('personaname');
  if (typeof name !== 'string' || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return [];
  return [name.trim()];
}

/**
 * Linux Steam records no running account in its registry.vdf. Steam marks the account it logged in as
 * MostRecent; otherwise the auto-login account (matched by its private login name, which is never returned),
 * otherwise the only remembered account. Several candidates and no marker select nobody.
 */
export function linuxActiveSteamAccount(loginUsers: string, autoLoginUser: string | null): number {
  const users = parseVdf(loginUsers)?.get('users');
  if (!(users instanceof Map)) return 0;
  const accounts = [...users].flatMap(([key, value]) => {
    if (!(value instanceof Map) || !/^\d{17}$/.test(key)) return [];
    const id = BigInt(key) - STEAM_INDIVIDUAL_BASE;
    return id > 0n && id <= 0xffffffffn ? [{ id: Number(id), user: value }] : [];
  });
  const pick = (matches: typeof accounts) => matches.length === 1 ? matches[0].id : 0;
  return pick(accounts.filter(({ user }) => user.get('mostrecent') === '1'))
    || (autoLoginUser ? pick(accounts.filter(({ user }) => typeof user.get('accountname') === 'string' && (user.get('accountname') as string).toLowerCase() === autoLoginUser.toLowerCase())) : 0)
    || pick(accounts);
}

/** AutoLoginUser from Linux Steam's registry.vdf (nested deeper than the strict parser allows), or null. */
export function linuxSteamAutoLoginUser(registry: string): string | null {
  if (Buffer.byteLength(registry, 'utf8') > MAX_VDF_BYTES) return null;
  const matches = [...registry.matchAll(/"AutoLoginUser"\s+"([^"\\\r\n]{1,64})"/gi)];
  return matches.length === 1 && matches[0][1].trim() ? matches[0][1].trim() : null;
}

async function loadLinuxPlayerNames(): Promise<string[]> {
  const home = homedir();
  // Native package, its usual symlink, then the Flatpak build.
  for (const root of [join(home, '.steam', 'steam'), join(home, '.local', 'share', 'Steam'), join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam')]) {
    const loginUsers = join(root, 'config', 'loginusers.vdf');
    try {
      if ((await stat(loginUsers)).size > MAX_VDF_BYTES) continue;
      const source = await readFile(loginUsers, 'utf8');
      let autoLogin: string | null = null;
      // This installation's own registry first: a Flatpak Steam must not take a leftover native ~/.steam/registry.vdf.
      for (const registry of [join(root, '..', '..', '..', '.steam', 'registry.vdf'), join(home, '.steam', 'registry.vdf')]) {
        try { if ((await stat(registry)).size <= MAX_VDF_BYTES) { autoLogin = linuxSteamAutoLoginUser(await readFile(registry, 'utf8')); break; } } catch { /* Try the next location. */ }
      }
      return steamDisplayNamesFromVdf(source, linuxActiveSteamAccount(source, autoLogin));
    } catch { /* Not this installation. */ }
  }
  return [];
}

/** One value from `reg.exe query <key> /v <name>` output (REG_SZ text or REG_DWORD number), or null. */
export function windowsRegistryValue(output: string, name: string): string | number | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s+${escaped}\\s+(REG_SZ|REG_EXPAND_SZ|REG_DWORD)\\s+(.*)$`, 'im').exec(output);
  if (!match) return null;
  const value = match[2].trim();
  if (match[1] === 'REG_DWORD') { const number = Number.parseInt(value, 16); return Number.isSafeInteger(number) ? number : null; }
  return value || null;
}

async function windowsRegistry(key: string, name: string): Promise<string | number | null> {
  try {
    // reg.exe answers in ~50 ms; PowerShell often needed over 2 s to start on machines with antivirus.
    const result = await execFileAsync('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 3000, maxBuffer: 16_384 });
    return windowsRegistryValue(result.stdout, name);
  } catch { return null; }
}

export async function loadLocalPlayerNames(): Promise<string[]> {
  if (process.platform === 'linux') return loadLinuxPlayerNames();
  if (process.platform !== 'win32') return [];
  try {
    const [path, active, autoLogin] = await Promise.all([
      windowsRegistry('HKCU\\Software\\Valve\\Steam', 'SteamPath'),
      windowsRegistry('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser'),
      windowsRegistry('HKCU\\Software\\Valve\\Steam', 'AutoLoginUser')]);
    // reg.exe prints in the console code page, which can mangle a non-ASCII Steam path; the default folder is the fallback.
    const roots = [typeof path === 'string' && !path.includes('\0') ? path : null,
      process.env['ProgramFiles(x86)'] ? join(process.env['ProgramFiles(x86)'], 'Steam') : null].filter((root): root is string => !!root);
    let source: string | null = null;
    for (const root of roots) {
      try {
        const loginUsers = join(root, 'config', 'loginusers.vdf');
        if ((await stat(loginUsers)).size <= MAX_VDF_BYTES) { source = await readFile(loginUsers, 'utf8'); break; }
      } catch { /* Try the next location. */ }
    }
    if (source === null) return [];
    // Steam not running yet (ActiveUser 0): the same remembered-account rules as on Linux.
    const account = typeof active === 'number' && active > 0 ? active : linuxActiveSteamAccount(source, typeof autoLogin === 'string' ? autoLogin : null);
    return steamDisplayNamesFromVdf(source, account);
  } catch { return []; }
}
