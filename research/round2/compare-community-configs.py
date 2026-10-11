"""Static parsing only. Does not import or execute downloaded config/tool code."""
from pathlib import Path
import hashlib
import json
import re
import zipfile
from datetime import datetime, timezone
from collections import Counter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'research' / 'round2'
REPO = ROOT / 'research' / 'optilock-source'
ENGINE = ROOT / 'evidence' / 'valve-build-25689475' / 'mirrored-engine'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def parse_kv(text):
    pattern = re.compile(r'\s+|//[^\r\n]*|"(?:\\.|[^"\\])*"|[{}]|[^\s{}"]+')
    tokens = []
    for match in pattern.finditer(text.lstrip('\ufeff')):
        raw = match.group()
        if raw.isspace() or raw.startswith('//'):
            continue
        value = re.sub(r'\\(["\\])', r'\1', raw[1:-1]) if raw.startswith('"') else raw
        tokens.append((raw, value, text.count('\n', 0, match.start()) + 1))
    cursor = 0
    def children(nested=False):
        nonlocal cursor
        result = []
        while cursor < len(tokens) and tokens[cursor][0] != '}':
            key = tokens[cursor]; cursor += 1
            if cursor >= len(tokens):
                raise ValueError('Missing value')
            value = tokens[cursor]; cursor += 1
            if key[0] == '{' or value[0] == '}':
                raise ValueError('Malformed pair')
            if value[0] == '{':
                group = children(True)
                if cursor >= len(tokens) or tokens[cursor][0] != '}':
                    raise ValueError('Unclosed object')
                cursor += 1
                result.append({'key':key[1], 'children':group, 'line':key[2]})
            else:
                result.append({'key':key[1], 'value':value[1], 'line':key[2]})
        return result
    result = children()
    if cursor != len(tokens):
        raise ValueError('Trailing tokens')
    return result

def find_named(nodes, name):
    result = []
    for node in nodes:
        if node['key'] == name:
            result.append(node)
        if 'children' in node:
            result.extend(find_named(node['children'], name))
    return result

def scalar_signature(text, filename):
    nodes = parse_kv(text)
    if filename.lower().endswith('gameinfo.gi'):
        groups = find_named(nodes, 'ConVars')
        members = [node for group in groups for node in group.get('children',[]) if 'value' in node]
    else:
        members = [node for root in nodes for node in root.get('children', []) if 'value' in node]
    return [(node['key'], node['value']) for node in members]

registry = {}
lines = (ENGINE / 'DumpSource2' / 'convars.txt').read_text(encoding='utf-8-sig').splitlines()
for index, line in enumerate(lines):
    match = re.match(r'^(\S+)\s+(.+?)\s+\(([^)]*)\)$', line)
    if match:
        registry[match[1]] = {'default':match[2], 'flags':match[3].split(), 'description':lines[index+1].strip() if index+1 < len(lines) else '', 'registry_line':index+1}

profile = json.loads((OUT / 'optilock-gamebanana-profile.json').read_text(encoding='utf-8-sig'))
archive_record = next(entry for entry in profile['_aFiles'] if entry['_idRow'] == 1834114)
comparisons = []
with zipfile.ZipFile(OUT / 'optilock-v5-archive.zip') as archive:
    for entry in archive.infolist():
        if entry.is_dir() or not entry.filename.lower().endswith(('.gi','.txt','.md')):
            continue
        local = (REPO / entry.filename).resolve()
        if not local.is_relative_to(REPO.resolve()):
            raise ValueError('Unsafe archive member')
        data = archive.read(entry)
        text = data.decode('utf-8-sig')
        comparison = {'archive_path':entry.filename,'archive_bytes':len(data),'archive_sha256':sha(data),'github_exists':local.is_file()}
        if local.is_file():
            existing = local.read_bytes()
            existing_text = existing.decode('utf-8-sig')
            comparison.update({'github_bytes':len(existing),'github_sha256':sha(existing),'byte_equal':data==existing,'equal_after_crlf_normalization':text.replace('\r\n','\n')==existing_text.replace('\r\n','\n')})
            if entry.filename.lower().endswith(('gameinfo.gi','video.txt')):
                try:
                    a = scalar_signature(text, entry.filename)
                    b = scalar_signature(existing_text, entry.filename)
                    comparison.update({'scalar_sequence_equal':a==b,'archive_scalar_assignments':len(a),'github_scalar_assignments':len(b)})
                    if a != b:
                        am = dict(a); bm = dict(b)
                        comparison['final_value_changes'] = [{'key':key,'archive':am.get(key),'github':bm.get(key)} for key in sorted(am.keys() | bm.keys()) if am.get(key)!=bm.get(key)]
                except ValueError as exc:
                    comparison['parse_error'] = str(exc)
        comparisons.append(comparison)

config_audits = []
for name in ['optimizationlock-sqooky-gameinfo.gi','optimizationlock-test-gameinfo.gi','optimizationlock-kaiz-gameinfo.gi']:
    path = OUT / name
    text = path.read_text(encoding='utf-8-sig')
    nodes = parse_kv(text)
    groups = find_named(nodes, 'ConVars')
    assignments = [node for group in groups for node in group.get('children', []) if 'value' in node]
    counts = Counter(node['key'] for node in assignments)
    final = {node['key']:node['value'] for node in assignments}
    normalized = []
    for node in assignments:
        normalized.append({**node, 'current_registry':registry.get(node['key'])})
    names = set(final)
    flag_counts = {flag:sum(flag in registry.get(name,{}).get('flags',[]) for name in names) for flag in ['developmentonly','cheat','gameinfo_cannot_override','defensive']}
    release_deviations = [{'name':name,'assigned':value,'registry':registry[name]} for name,value in final.items() if name in registry and not any(flag in registry[name]['flags'] for flag in ['developmentonly','cheat','gameinfo_cannot_override']) and value.strip('"').lower()!=registry[name]['default'].strip('"').lower()]
    config_audits.append({'path':name,'sha256':sha(path.read_bytes()),'assignments':len(assignments),'unique_names':len(names),'duplicate_names':sum(value>1 for value in counts.values()),'unknown_names':sorted(names-registry.keys()),'flag_counts':flag_counts,'release_deviations':release_deviations,'all_assignments':normalized})

result = {'retrieved_utc':datetime.now(timezone.utc).isoformat(),'method':'Read-only static ZIP and KeyValues parse; no external optimizer or game code executed','optilock_archive':{'file_id':1834114,'download_url':archive_record['_sDownloadUrl'],'version':archive_record['_sVersion'],'added_utc':datetime.fromtimestamp(archive_record['_tsDateAdded'],timezone.utc).isoformat(),'archive_sha256':sha((OUT/'optilock-v5-archive.zip').read_bytes()),'github_commit':'7f7a54a1b8237d9b66348067d09f93174c47d303','files':comparisons},'optimizationlock_commit':'a70ba39997f4f2e43f0622ad8160ce099e2fa5ae','current_registry_source':str(ENGINE/'DumpSource2'/'convars.txt'),'configs':config_audits}
(OUT/'community-config-static-audit.json').write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print(json.dumps({'archive_text_files':len(comparisons),'archive_byte_identical':sum(row.get('byte_equal',False) for row in comparisons),'normalized_equal':sum(row.get('equal_after_crlf_normalization',False) for row in comparisons),'scalar_sequence_changes':[row for row in comparisons if row.get('scalar_sequence_equal') is False],'configs':[{key:value for key,value in row.items() if key not in ['all_assignments','release_deviations','unknown_names']} for row in config_audits],'release_deviations':[{ 'path':row['path'],'settings':row['release_deviations']} for row in config_audits]},indent=2))
