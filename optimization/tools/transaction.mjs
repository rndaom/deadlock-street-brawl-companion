import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from './config-core.mjs';

export function writeAtomic(target, bytes) {
  const temporary = `${target}.deadlock-fps-${randomUUID()}.tmp`;
  let written = false;
  try {
    const fd = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, target);
    written = true;
  } finally {
    if (!written && fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function assertOriginals(files) {
  for (const file of files) {
    const stat = fs.lstatSync(file.target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Target is not a regular file: ${file.name}`);
    if (sha256(fs.readFileSync(file.target)) !== file.beforeHash) {
      throw new Error(`Settings changed since preparation: ${file.name}. Prepare a new plan after Steam synchronization.`);
    }
  }
}

// Each transaction is limited by the caller to the two account-scoped setting
// files. All originals are backed up and verified before the first replacement.
// A second guard and a hash recheck close common game/Cloud save races.
export function commitFiles(files, backupRoot, guard, context, hooks = {}) {
  guard();
  assertOriginals(files);
  const backupDirectory = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
  fs.mkdirSync(backupDirectory, { recursive: true });
  const manifest = { format: 1, status: 'prepared', createdAt: new Date().toISOString(), context, files: [] };
  for (const file of files) {
    const original = fs.readFileSync(file.target);
    const backup = path.join(backupDirectory, file.name);
    fs.writeFileSync(backup, original, { flag: 'wx' });
    if (sha256(fs.readFileSync(backup)) !== file.beforeHash) throw new Error(`Backup verification failed: ${file.name}`);
    if (sha256(file.content) !== file.afterHash) throw new Error(`Candidate verification failed: ${file.name}`);
    manifest.files.push({ name: file.name, target: file.target, beforeHash: file.beforeHash, afterHash: file.afterHash });
  }
  const manifestPath = path.join(backupDirectory, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const replaced = [];
  try {
    guard();
    assertOriginals(files);
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      hooks.beforeWrite?.(index, file);
      // Recheck just before each individual replacement, too.
      guard();
      if (sha256(fs.readFileSync(file.target)) !== file.beforeHash) throw new Error(`Concurrent settings write: ${file.name}`);
      writeAtomic(file.target, file.content);
      replaced.push(file);
      if (sha256(fs.readFileSync(file.target)) !== file.afterHash) throw new Error(`Installed settings verification failed: ${file.name}`);
    }
    manifest.status = 'applied';
    manifest.completedAt = new Date().toISOString();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { backupDirectory, manifest };
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = error.message;
    manifest.rollback = [];
    for (const file of replaced.reverse()) {
      try {
        // Preserve evidence of the attempted candidate; never blindly overwrite
        // a file another writer changed while the transaction was failing.
        guard();
        if (sha256(fs.readFileSync(file.target)) !== file.afterHash) throw new Error('Concurrent writer; original retained in backup for explicit restore');
        const backupBytes = fs.readFileSync(path.join(backupDirectory, file.name));
        if (sha256(backupBytes) !== file.beforeHash) throw new Error('Backup changed; rollback refused');
        writeAtomic(file.target, backupBytes);
        if (sha256(fs.readFileSync(file.target)) !== file.beforeHash) throw new Error('Rollback hash mismatch');
        manifest.rollback.push({ name: file.name, restored: true });
      } catch (rollbackError) {
        manifest.rollback.push({ name: file.name, restored: false, error: rollbackError.message });
      }
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    error.message += ` Original settings remain in ${backupDirectory}`;
    throw error;
  }
}
