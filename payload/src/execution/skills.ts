import path from 'node:path';
import { AnchoredDir } from '../anchored-dir.js';

/** Synchronous, descriptor-anchored reconciliation: one host cannot interleave starts. */
export function reconcileNativeSkills(group: string, provider: string, selected: string[], shared: string): void {
  const dir = AnchoredDir.open(group, ['.home', provider === 'claude' ? '.claude' : '.agents', 'skills'], true)!;
  try {
    const desired = new Set(selected);
    for (const name of dir.entries()) {
      if (!dir.lstat(name).isSymbolicLink()) continue;
      // Only links to this installation's exact managed target belong to us.
      if (dir.readlink(name) === path.join(shared, name) && !desired.has(name)) dir.unlink(name);
    }
    for (const name of desired) {
      const target = path.join(shared, name);
      try {
        const stat = dir.lstat(name);
        if (stat.isSymbolicLink() && dir.readlink(name) === target) continue;
        throw new Error(`Selected runtime skill conflicts with an agent-authored entry: ${name}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      dir.symlink(target, name);
    }
  } finally { dir.close(); }
}
