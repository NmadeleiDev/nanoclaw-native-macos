import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { createSession } from '../db/sessions.js';
import { reconfigureSession, stageExecutionChanges } from './transitions.js';
const f=vi.hoisted(()=>({root:'', claims:[] as string[], messages:[] as any[], running:false,wakes:0}));
vi.mock('../config.js',async original=>{
  const actual=await original<typeof import('../config.js')>(); const fs=await import('node:fs'),path=await import('node:path');
  fs.mkdirSync('.cache',{recursive:true});f.root=fs.mkdtempSync(path.resolve('.cache/transition-'));return {...actual,DATA_DIR:f.root};
});
vi.mock('../container-runner.js',()=>({
  isContainerRunning:()=>f.running,
  beginAgentConfiguration:()=>({settle:async()=>{},release:()=>{}}),
  killContainer:(_id:string,_reason:string,done:()=>void)=>{f.running=false;done();},
}));
vi.mock('../session-manager.js',()=>({
  sessionDir:()=>f.root, sessionContextPath:()=>f.root,
  withMailboxSession:async(_g:string,_s:string,fn:any)=>fn({
    getProcessingClaims:()=>f.claims.map(messageId=>({messageId})),setWorkspaceControl:()=>{},
    markMessageFailed:(id:string)=>{f.claims=f.claims.filter(c=>c!==id);},
  }),
  writeSessionMessage:async(_g:string,_s:string,message:any)=>{if(!f.messages.some(m=>m.id===message.id))f.messages.push(message);},
}));
vi.mock('../request-wake.js',()=>({requestWake:async()=>{f.wakes++;}}));
beforeEach(async()=>{
  f.claims=[];f.messages=[];f.running=false;f.wakes=0;
  await runMigrations(await initTestDb());
  await createAgentGroup({id:'g',folder:'g',name:'G',agent_provider:null,created_at:new Date().toISOString()});
  await createSession({id:'s',agent_group_id:'g',messaging_group_id:null,thread_id:null,agent_provider:'claude',runtime_driver:'native-macos',status:'active',container_status:'stopped',last_active:null,created_at:new Date().toISOString()});
});
afterEach(async()=>{await closeDb();fs.rmSync(path.join(f.root,'native'),{recursive:true,force:true});});
it('does not wake idle conversations after a permission update',async()=>{
  await stageExecutionChanges(getDb(),['s']);await reconfigureSession('s');
  expect(f.messages).toEqual([]);expect(f.wakes).toBe(0);
  expect(await getDb().get('SELECT state FROM execution_transitions WHERE session_id=?','s')).toEqual({state:'complete'});
});
it('coalesces concurrent changes and creates one continuation without replaying interrupted messages',async()=>{
  f.claims=['inbound-1'];f.running=true;await stageExecutionChanges(getDb(),['s']);
  await Promise.all([reconfigureSession('s'),reconfigureSession('s')]);
  expect(f.messages).toHaveLength(1);expect(f.messages[0].onWake).toBe(true);expect(f.messages[0].content).toContain('inbound-1');expect(f.claims).toEqual([]);expect(f.wakes).toBe(1);
});
it('retains a blocked transition and recovers it after cleanup is verified',async()=>{
  const control=path.join(f.root,'native/s/control');fs.mkdirSync(control,{recursive:true});fs.writeFileSync(path.join(control,'lease.json'),'{}');
  f.claims=['inbound-1'];await stageExecutionChanges(getDb(),['s']);
  await expect(reconfigureSession('s')).rejects.toThrow('lease remains');expect(f.messages).toEqual([]);
  const pending=await getDb().get<{id:string;state:string}>('SELECT id,state FROM execution_transitions WHERE session_id=?','s');expect(pending?.state).toBe('pending');
  fs.unlinkSync(path.join(control,'lease.json'));await reconfigureSession('s');
  expect(f.messages).toHaveLength(1);expect(f.messages[0].id).toBe('execution-'+pending?.id);
});
