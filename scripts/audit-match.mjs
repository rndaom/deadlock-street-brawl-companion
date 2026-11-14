#!/usr/bin/env node
// Read-only audit of one finished Street Brawl match against the companion's reader log.
//   node scripts/audit-match.mjs <matchId> [--log <reader-log.jsonl>] [--match-json <record.json>] [--player <account id>]
//                                [--catalog <public-catalog.json>] [--slack <seconds>] [--all-log]
// The match record is fetched once from the public deadlock-api, only when this runs, unless --match-json
// points at a saved copy (then it works offline and <matchId> may be left out). Nothing is written.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SLACK_S, auditMatch, buildIndex, formatReport, normalizeMatch, parseLog } from './lib/match-audit.mjs';

const API = 'https://api.deadlock-api.com';
const USAGE = 'Usage: node scripts/audit-match.mjs <matchId> [--log <reader-log.jsonl>] [--match-json <record.json>] [--player <account id>] [--catalog <file>] [--slack <seconds>] [--all-log]';
const defaultLog = path.join(os.homedir(), 'Documents', 'Street Brawl Companion', 'diagnostics', 'reader-log.jsonl');
const defaultCatalog = fileURLToPath(new URL('../data/public-catalog.json', import.meta.url));

function parseArgs(argv) {
  const args = { matchId: null, log: defaultLog, matchJson: null, player: null, catalog: defaultCatalog, slack: DEFAULT_SLACK_S, allLog: false };
  const value = (i, flag) => { if (i + 1 >= argv.length) throw new Error(`${flag} needs a value.`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--log') args.log = value(i++, arg);
    else if (arg === '--match-json') args.matchJson = value(i++, arg);
    else if (arg === '--player') args.player = value(i++, arg);
    else if (arg === '--catalog') args.catalog = value(i++, arg);
    else if (arg === '--slack') args.slack = Number(value(i++, arg));
    else if (arg === '--all-log') args.allLog = true;
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0); }
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}.`);
    else if (args.matchId === null) args.matchId = arg;
    else throw new Error(`Unexpected argument ${arg}.`);
  }
  if (args.matchId !== null && !/^\d+$/.test(args.matchId)) throw new Error('<matchId> must be a number.');
  if (args.player !== null && !/^\d+$/.test(args.player)) throw new Error('--player must be a numeric account id.');
  if (!Number.isFinite(args.slack) || args.slack < 0) throw new Error('--slack must be a number of seconds.');
  if (args.matchId === null && args.matchJson === null) throw new Error('Give a <matchId>, or --match-json with a saved record.');
  return args;
}

async function loadRecord(args) {
  if (args.matchJson) return JSON.parse(await fs.readFile(args.matchJson, 'utf8'));
  const response = await fetch(`${API}/v1/matches/${args.matchId}/metadata`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 429) throw new Error('deadlock-api rate limit reached; try again in a few minutes.');
  if (!response.ok) throw new Error(`deadlock-api returned ${response.status} for match ${args.matchId}; it may not be processed yet (usually a few minutes after the match), or the id is wrong.`);
  return response.json();
}

try {
  const args = parseArgs(process.argv.slice(2));
  const match = normalizeMatch(await loadRecord(args));
  if (args.matchId !== null && match.matchId !== null && String(match.matchId) !== args.matchId) throw new Error(`The record is for match ${match.matchId}, not ${args.matchId}.`);
  if (!match.isStreetBrawl) throw new Error(`Match ${match.matchId ?? args.matchId} is not a Street Brawl match (game mode ${match.gameMode || 'unknown'}).`);
  let logText;
  try { logText = await fs.readFile(args.log, 'utf8'); } catch (error) { throw new Error(`Cannot read the reader log at ${args.log} (${error.code ?? error.message}). Pass --log.`); }
  const index = buildIndex(JSON.parse(await fs.readFile(args.catalog, 'utf8')));
  const result = auditMatch({ match, entries: parseLog(logText), index, accountId: args.player === null ? null : Number(args.player), slackS: args.slack, windowed: !args.allLog });
  console.log(formatReport(result));
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(1);
}
