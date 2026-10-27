import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { nativeInstructionContext, sessionInstructionsPath, projectRuleFiles } from './instruction-context.js';
import { prepareOpenCodeMemory } from './providers/opencode-memory.js';
const roots: string[] = [];
const original = process.env.NANOCLAW_RUNNER_LAYOUT;
afterEach(() => {
  if (original === undefined) delete process.env.NANOCLAW_RUNNER_LAYOUT; else process.env.NANOCLAW_RUNNER_LAYOUT = original;
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true});
});
function fixture() {
  const base=path.resolve('../../.cache');fs.mkdirSync(base,{recursive:true});
  const root=fs.mkdtempSync(path.join(base,'instruction-context-'));roots.push(root);
  const group=path.join(root,'agent'), repo=path.join(root,'repo');fs.mkdirSync(group);fs.mkdirSync(repo);fs.mkdirSync(path.join(repo,'.git'));
  fs.writeFileSync(path.join(group,'instructions.prepend.md'),'CREED_A');
  const instructions=path.join(root,'runtime.md');fs.writeFileSync(instructions,'RUNTIME_ONLY');
  const layout={kind:'native',agent:group,session:path.join(root,'session-a'),source:root,config:path.join(root,'config'),context:path.join(root,'context'),instructions,turnInstructions:path.join(root,'a','turn.md'),additionalDirectories:[],executables:{}};
  process.env.NANOCLAW_RUNNER_LAYOUT=JSON.stringify(layout);
  return {root,group,repo,layout};
}
describe('native instruction ownership',()=>{
  it('loads mutable persona once, preserves project rules, and separates provider runtime ownership',()=>{
    const f=fixture();fs.writeFileSync(path.join(f.repo,'AGENTS.md'),'PROJECT_A');fs.writeFileSync(path.join(f.repo,'CLAUDE.md'),'FALLBACK_NOT_USED');
    expect(nativeInstructionContext(f.repo,'opencode')).toBe('CREED_A\n\nProject rules ('+path.join(f.repo,'AGENTS.md')+'):\nPROJECT_A');
    const claude=nativeInstructionContext(f.repo,'claude');expect(claude.match(/RUNTIME_ONLY/g)).toHaveLength(1);expect(claude.match(/CREED_A/g)).toHaveLength(1);
    fs.writeFileSync(path.join(f.group,'instructions.prepend.md'),'CREED_B');expect(nativeInstructionContext(f.repo,'opencode')).toContain('CREED_B');
  });
  it('does not load the generated agent document as a project rule',()=>{const f=fixture();fs.writeFileSync(path.join(f.group,'CLAUDE.md'),'DUPLICATE');expect(projectRuleFiles(f.group,f.group)).toEqual([]);});
  it('keeps delayed readers isolated while two conversations share HOME and XDG state',async()=>{
    const f=fixture();const first=sessionInstructionsPath();
    process.env.NANOCLAW_RUNNER_LAYOUT=JSON.stringify({...f.layout,session:path.join(f.root,'session-b'),turnInstructions:path.join(f.root,'b','turn.md')});
    const second=sessionInstructionsPath();expect(first).not.toBe(second);
    const hook={command:'printf MEMORY',legacyCommands:[],sources:['startup']};
    await Promise.all([prepareOpenCodeMemory(hook,'CONVERSATION_A','ROUTE_A',first),prepareOpenCodeMemory(hook,'CONVERSATION_B','ROUTE_B',second)]);
    expect(fs.readFileSync(first,'utf8')).toBe('MEMORY\n\nCONVERSATION_A\n\nROUTE_A');
    expect(fs.readFileSync(second,'utf8')).toBe('MEMORY\n\nCONVERSATION_B\n\nROUTE_B');
  });
});
