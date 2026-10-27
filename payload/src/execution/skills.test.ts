import { it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { reconcileNativeSkills } from './skills.js';
it('removes only managed links and preserves authored skills, including on collision',()=>{
  fs.mkdirSync('.cache',{recursive:true});const root=fs.mkdtempSync(path.resolve('.cache/skill-sync-'));
  try {
    const shared=path.join(root,'shared'),group=path.join(root,'group');fs.mkdirSync(shared);fs.mkdirSync(group);
    reconcileNativeSkills(group,'opencode',['one','two'],shared);
    const home=path.join(group,'.home/.agents/skills');fs.mkdirSync(path.join(home,'authored'));
    reconcileNativeSkills(group,'opencode',['two'],shared);
    expect(fs.readdirSync(home).sort()).toEqual(['authored','two']);
    expect(()=>reconcileNativeSkills(group,'opencode',['authored'],shared)).toThrow('conflicts');
    expect(fs.statSync(path.join(home,'authored')).isDirectory()).toBe(true);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
