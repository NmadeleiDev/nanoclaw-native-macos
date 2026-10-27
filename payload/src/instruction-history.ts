import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { AnchoredDir } from './anchored-dir.js';

export const instructionHash = (text: string) => createHash('sha256').update(text).digest('hex');
export class InstructionHistory {
  constructor(readonly root = path.join(DATA_DIR, 'instruction-history')) {}
  private directory(agentId: string) { return path.join(this.root, instructionHash(agentId)); }
  observe(agentId: string, content: string) {
    if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error('Standing instructions exceed 4 MiB');
    const hash = instructionHash(content);
    const directory = this.directory(agentId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const entry = { hash, observedAt: new Date().toISOString(), content };
    try { fs.writeFileSync(path.join(directory, hash + '.json'), JSON.stringify(entry), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return hash;
  }
  readCurrent(group: string): string {
    const directory = AnchoredDir.open(group, []);
    if (!directory) throw new Error('Agent directory is missing');
    try {
      const fd = directory.openReadFd('instructions.prepend.md');
      try {
        if (fs.fstatSync(fd).size > 4 * 1024 * 1024) throw new Error('Standing instructions exceed 4 MiB');
        return fs.readFileSync(fd, 'utf8');
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    } finally { directory.close(); }
  }
  list(agentId: string): Array<{ hash: string; observedAt: string; content: string }> {
    const directory = this.directory(agentId);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')))
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  }
  restore(agentId: string, group: string, hash: string, expectedHash: string) {
    const previous = this.readCurrent(group);
    if (instructionHash(previous) !== expectedHash) throw new Error('Standing instructions changed; reload before restoring');
    const entry = this.list(agentId).find(entry => entry.hash === hash);
    if (!entry) throw new Error('Instruction version not found');
    this.observe(agentId, previous);
    const directory = AnchoredDir.open(group, [])!;
    try { directory.replaceFile('instructions.prepend.md', entry.content); }
    finally { directory.close(); }
    // A restore is an event even if this content was seen previously.
    const stamp = new Date().toISOString();
    fs.appendFileSync(path.join(this.directory(agentId), 'restores.jsonl'), JSON.stringify({ at: stamp, from: expectedHash, to: hash }) + '\n', { mode: 0o600 });
    return { hash, restoredAt: stamp };
  }
}
