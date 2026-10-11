import { describe, expect, it } from 'vitest';
import { steamDisplayNamesFromVdf } from '../electron/local-identity';

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
