import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILES, MACHINE_SETTINGS, LEGACY_VIDEO_KEYS } from './config-core.mjs';

const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../profiles');
fs.mkdirSync(output, { recursive: true });
for (const [id, profile] of Object.entries(PROFILES)) {
  const artifact = { id, name: profile.name, description: profile.description,
    build: '25689475', client: '6745', measuredWinner: false,
    installation: 'Use optimizer.mjs prepare/apply; this is a patch specification, not a replacement gameinfo or whole video file.',
    videoSettings: profile.video, machineSettings: MACHINE_SETTINGS,
    removeNonmenuManualVideoKeys: LEGACY_VIDEO_KEYS };
  fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(artifact, null, 2) + '\n');
}
console.log(`Exported ${Object.keys(PROFILES).length} audited candidate specifications.`);
