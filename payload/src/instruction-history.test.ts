import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { InstructionHistory, instructionHash } from './instruction-history.js';
it('records versions outside agent state and rejects restoring over a concurrent edit',()=>{
  fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/instruction-history-'));
  try {
    const group=path.join(root,'group');fs.mkdirSync(group);const file=path.join(group,'instructions.prepend.md');
    const history=new InstructionHistory(path.join(root,'history'));fs.writeFileSync(file,'FIRST');const first=history.observe('agent','FIRST');
    fs.writeFileSync(file,'SECOND');history.observe('agent','SECOND');
    expect(()=>history.restore('agent',group,first,first)).toThrow('changed');
    history.restore('agent',group,first,instructionHash('SECOND'));expect(fs.readFileSync(file,'utf8')).toBe('FIRST');expect(history.list('agent')).toHaveLength(2);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
