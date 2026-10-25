import { describe, expect, it } from 'vitest';
import { linuxActiveSteamAccount, linuxSteamAutoLoginUser, steamDisplayNamesFromVdf } from '../electron/local-identity';

const fixture = `"users" {
  "76561197960265729" { "PersonaName" "Older account" "MostRecent" "1" }
  "76561197960265730" { "PersonaName" "Current Hero" "MostRecent" "0" }
}`;

describe('local Steam name hints', () => {
  it('selects the running Steam account instead of a remembered recent account', () => {
    expect(steamDisplayNamesFromVdf(fixture, 2)).toEqual(['Current Hero']);
  });
  it('does not guess an account when Steam has no active account or it is absent', () => {
    expect(steamDisplayNamesFromVdf(fixture, 0)).toEqual([]);
    expect(steamDisplayNamesFromVdf(fixture, 3)).toEqual([]);
  });
  it('keeps a quoted display name without returning account names or identifiers', () => {
    expect(steamDisplayNamesFromVdf('"users" { "76561197960265729" { "PersonaName" "A \\"quoted\\" name" "AccountName" "private-account" } }', 1)).toEqual(['A "quoted" name']);
  });
  it('rejects duplicate keys, malformed files and excessive input rather than selecting another account', () => {
    expect(steamDisplayNamesFromVdf('"users" { "76561197960265729" { "PersonaName" "A" "PersonaName" "B" } }', 1)).toEqual([]);
    expect(steamDisplayNamesFromVdf('"users" { "76561197960265729" { "PersonaName" "A" }', 1)).toEqual([]);
    expect(steamDisplayNamesFromVdf(' '.repeat(128 * 1024 + 1), 1)).toEqual([]);
  });
  it('rejects invalid account numbers and blank or control-character aliases', () => {
    for (const account of [-1, 1.2, NaN, 0x100000000]) expect(steamDisplayNamesFromVdf(fixture, account)).toEqual([]);
    expect(steamDisplayNamesFromVdf('"users" { "76561197960265729" { "PersonaName" " " } }', 1)).toEqual([]);
    expect(steamDisplayNamesFromVdf('"users" { "76561197960265729" { "PersonaName" "A\u0000B" } }', 1)).toEqual([]);
  });
});

describe('Linux Steam active account', () => {
  const users = (entries: string) => `"users" { ${entries} }`;
  it('takes the account Steam marked as most recent', () => {
    expect(linuxActiveSteamAccount(fixture, null)).toBe(1);
  });
  it('falls back to the auto-login account, then to the only remembered account', () => {
    const two = users('"76561197960265729" { "AccountName" "first" "PersonaName" "A" } "76561197960265730" { "AccountName" "Second" "PersonaName" "B" }');
    expect(linuxActiveSteamAccount(two, 'second')).toBe(2);
    expect(linuxActiveSteamAccount(two, null)).toBe(0);
    expect(linuxActiveSteamAccount(users('"76561197960265731" { "PersonaName" "Solo" }'), null)).toBe(3);
  });
  it('selects nobody when several accounts are marked or the file is malformed', () => {
    expect(linuxActiveSteamAccount(users('"76561197960265729" { "MostRecent" "1" } "76561197960265730" { "MostRecent" "1" }'), null)).toBe(0);
    expect(linuxActiveSteamAccount('"users" {', null)).toBe(0);
  });
  it('reads the auto-login user from a deeply nested registry.vdf', () => {
    const registry = '"Registry" { "HKCU" { "Software" { "Valve" { "Steam" { "language" "english" "AutoLoginUser" "someone" } } } } }';
    expect(linuxSteamAutoLoginUser(registry)).toBe('someone');
    expect(linuxSteamAutoLoginUser('"Registry" { }')).toBeNull();
  });
});
