// electron/local-identity.ts
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var MAX_VDF_BYTES = 128 * 1024;
var STEAM_INDIVIDUAL_BASE = 76561197960265728n;
function steamDisplayNamesFromVdf(source, activeAccountId) {
  if (Buffer.byteLength(source, "utf8") > MAX_VDF_BYTES || !Number.isSafeInteger(activeAccountId) || activeAccountId <= 0 || activeAccountId > 4294967295) return [];
  const tokens = [];
  const pattern = /\s+|\/\/[^\r\n]*|"((?:\\.|[^"\\])*)"|[{}]/gy;
  let position = 0;
  while (position < source.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match) return [];
    position = pattern.lastIndex;
    if (match[0].trim().length === 0 || match[0].startsWith("//")) continue;
    const token = match[1] === void 0 ? match[0] : match[1].replace(/\\([\\"])/g, "$1");
    if (token.includes("\0") || token.length > 512 || tokens.length > 4096) return [];
    tokens.push(token);
  }
  let index = 0;
  function object(depth, nested) {
    if (depth > 4) return null;
    const output = /* @__PURE__ */ new Map();
    while (index < tokens.length) {
      const key = tokens[index++];
      if (key === "}") return nested ? output : null;
      if (key === "{" || index >= tokens.length || output.has(key.toLowerCase())) return null;
      const value = tokens[index++];
      if (value === "}") return null;
      if (value === "{") {
        const child = object(depth + 1, true);
        if (!child) return null;
        output.set(key.toLowerCase(), child);
      } else output.set(key.toLowerCase(), value);
    }
    return nested ? null : output;
  }
  const parsed = object(0, false);
  if (!parsed || index !== tokens.length) return [];
  const users = parsed.get("users");
  if (!(users instanceof Map)) return [];
  const account = users.get(String(STEAM_INDIVIDUAL_BASE + BigInt(activeAccountId)));
  if (!(account instanceof Map)) return [];
  const name = account.get("personaname");
  if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) return [];
  return [name.trim()];
}
async function loadLocalPlayerNames() {
  if (process.platform !== "win32") return [];
  try {
    const command = "$steamAliasRoot = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam' -ErrorAction Stop; $steamAliasActive = Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Valve\\Steam\\ActiveProcess' -ErrorAction Stop; [pscustomobject]@{ path = $steamAliasRoot.SteamPath; account = $steamAliasActive.ActiveUser } | ConvertTo-Json -Compress";
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 2e3, maxBuffer: 4096 });
    const registry = JSON.parse(result.stdout);
    if (!registry || typeof registry !== "object" || Array.isArray(registry)) return [];
    const record = registry;
    if (typeof record.path !== "string" || !record.path || record.path.includes("\0") || typeof record.account !== "number") return [];
    const loginUsers = join(record.path, "config", "loginusers.vdf");
    if ((await stat(loginUsers)).size > MAX_VDF_BYTES) return [];
    return steamDisplayNamesFromVdf(await readFile(loginUsers, "utf8"), record.account);
  } catch {
    return [];
  }
}
export {
  loadLocalPlayerNames,
  steamDisplayNamesFromVdf
};
