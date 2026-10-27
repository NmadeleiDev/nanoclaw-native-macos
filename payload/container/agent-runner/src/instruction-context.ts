import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { runtimeLayout } from './runtime-layout.js';

export interface InstructionSource {
  path: string;
  scope: 'agent' | 'runtime' | 'project' | 'memory';
  status: 'included' | 'missing';
  hash?: string;
  bytes?: number;
  text?: string;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export function sessionInstructionsPath(): string {
  const layout = runtimeLayout();
  if (layout.kind === 'container') return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'nanoclaw-instructions.md');
  return layout.turnInstructions ?? path.join(layout.session, 'outbox', '.nanoclaw-instructions.md');
}
export function projectRuleFiles(cwd: string, agent: string): string[] {
  if (path.resolve(cwd) === path.resolve(agent)) return [];
  const directories: string[] = [];
  let dir = path.resolve(cwd);
  // Stay within the repository. An unattached ancestor's rules must not become agent identity.
  while (true) {
    directories.unshift(dir);
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir || dir === path.resolve(agent)) {
      directories.splice(0, directories.length - 1);
      break;
    }
    dir = parent;
  }
  return directories.flatMap(directory => {
    const file = ['AGENTS.md', 'CLAUDE.md'].map(name => path.join(directory, name)).find(file => fs.existsSync(file));
    return file ? [file] : [];
  });
}

/** Native context is assembled once at a provider turn boundary, never by the model. */
export function nativeInstructionContext(cwd: string, provider: string, includeRuntime = provider !== 'opencode'): string {
  const layout = runtimeLayout();
  if (layout.kind !== 'native') return '';
  const sources: InstructionSource[] = [];
  const read = (file: string, scope: InstructionSource['scope'], required = false): string => {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        sources.push({ path: file, scope, status: 'missing' }); return '';
      }
      throw error;
    }
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error(`Instruction source exceeds 4 MiB: ${file}`);
    sources.push({ path: file, scope, status: 'included', hash: hash(text), bytes: Buffer.byteLength(text), text });
    return text;
  };
  const runtime = read(layout.instructions!, 'runtime', true);
  const persona = read(path.join(layout.agent, 'instructions.prepend.md'), 'agent');
  const project = projectRuleFiles(cwd, layout.agent).map(file => `Project rules (${file}):\n${read(file, 'project', true)}`);
  if (sources.reduce((total, source) => total + (source.bytes ?? 0), 0) > 4 * 1024 * 1024) throw new Error('Combined native instructions exceed 4 MiB');
  const text = [persona, ...(includeRuntime ? [runtime] : []), ...project].filter(Boolean).join('\n\n');
  // This records the supplied sources, not the provider's hidden system prompt.
  const manifest = { version: 1, capturedAt: new Date().toISOString(), provider, runtime: layout.kind,
    cwd, home: process.env.HOME, sources, standingInstructions: persona, projectDiscovery: 'explicit',
    note: 'NanoClaw-supplied sources; provider-internal context is not included.' };
  const file = sessionInstructionsPath() + '.manifest.json';
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return text;
}

export function recordMemoryContext(text: string): void {
  if (runtimeLayout().kind !== 'native') return;
  const file = sessionInstructionsPath() + '.manifest.json';
  if (!fs.existsSync(file)) return;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.memory = { text, hash: hash(text), bytes: Buffer.byteLength(text), capturedAt: new Date().toISOString(), status: 'rendered' };
  const tmp = file + '.' + randomUUID();
  fs.writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
