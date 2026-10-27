#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {auditDistribution} from './release.mjs';
const release=path.dirname(fileURLToPath(import.meta.url));
auditDistribution(release);
const args=process.argv.slice(2), i=args.indexOf('--target');
if(i<0 || !args[i+1]) throw Error('Usage: node install.mjs --target /path/to/nanoclaw --check|--apply|--check-remove|--remove');
const mode=args.find(v=>['--check','--apply','--check-remove','--remove'].includes(v))||'--check';
const target=fs.realpathSync(path.resolve(args[i+1]));
const read=f=>fs.readFileSync(f);
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=f=>JSON.parse(read(path.join(release,f)));
const manifest=json('manifest.json'), base=json('base-files.json'), compatibility=json('compatibility.json');
function safe(rel) {
 if(path.isAbsolute(rel)||rel.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw Error('Unsafe target path: '+rel);
 let current=target;
 for(const part of rel.split('/')){
  current=path.join(current,part);
  try{if(fs.lstatSync(current).isSymbolicLink())throw Error('Refusing symlink: '+rel)}
  catch(e){if(e.code!=='ENOENT')throw e}
 }
 return current;
}
const statePath=safe('.nanoclaw/addons/native-macos/state.json');
const state=fs.existsSync(statePath)?JSON.parse(read(statePath)):null;
const touched=[...manifest,...Object.keys(base)];
if(new Set(touched).size!==touched.length)throw Error('Duplicate target ownership');
for(const rel of touched)safe(rel);
const git=(reverse=false,check=true)=>spawnSync('git',['apply',...(reverse?['--reverse']:[]),...(check?['--check']:[]),path.join(release,'integration.patch')],{cwd:target,encoding:'utf8'});
function check(result){if(result.status!==0)throw Error(result.stderr||result.stdout||'git apply failed')}
if(state){
 if(state.version!==compatibility.version || JSON.stringify(Object.keys(state.hashes).sort())!==JSON.stringify([...touched].sort()))throw Error('Use the installed version to remove or migrate this add-on');
 for(const rel of touched)if(!fs.existsSync(safe(rel))||hash(read(safe(rel)))!==state.hashes[rel])throw Error('Source changed; preserve and reconcile before proceeding: '+rel);
 check(git(true));
 if(!mode.includes('remove')){console.log('Native macOS add-on already installed; source checks passed.');process.exit(0)}
}else{
 if(mode.includes('remove'))throw Error('This target has no native-macos installation record');
 for(const [rel,expected] of Object.entries(base))if(!fs.existsSync(safe(rel))||hash(read(safe(rel)))!==expected)throw Error('Unsupported or edited upstream source: '+rel);
 for(const rel of manifest)if(fs.existsSync(safe(rel)))throw Error('Refusing to overwrite existing source: '+rel);
 check(git());
}
if(mode==='--check'||mode==='--check-remove'){console.log('Preflight passed; no files changed.');process.exit(0)}
const socket=path.join(target,'data/ncl.sock');
if(fs.existsSync(socket)){
 const running=await new Promise(resolve=>{
  const c=net.connect(socket);let done=false;
  const finish=v=>{if(!done){done=true;c.destroy();resolve(v)}};
  c.on('connect',()=>finish(true));c.on('error',()=>finish(false));c.setTimeout(500,()=>finish(true));
 });
 if(running)throw Error('Stop the target host before applying or removing source. The installer never stops services.');
}
const removing=mode==='--remove';
if(removing&&fs.existsSync(path.join(target,'data/v2.db'))&&!args.includes('--confirm-runtime-retired'))
 throw Error('Retire native sessions, restore Docker defaults and provider/gateway source first; see REMOVE.md. Then pass --confirm-runtime-retired. User data is retained.');
const before=new Map(touched.map(rel=>[rel,fs.existsSync(safe(rel))?read(safe(rel)):null]));
try{
 check(git(removing,false));
 for(const rel of manifest){
  if(removing)fs.unlinkSync(safe(rel));
  else{fs.mkdirSync(path.dirname(safe(rel)),{recursive:true});fs.writeFileSync(safe(rel),read(path.join(release,'payload',rel)))}
 }
 if(removing)fs.unlinkSync(statePath);
 else{
  fs.mkdirSync(path.dirname(statePath),{recursive:true,mode:0o700});
  fs.writeFileSync(statePath,JSON.stringify({version:compatibility.version,hashes:Object.fromEntries(touched.map(rel=>[rel,hash(read(safe(rel)))]))},null,2)+'\n',{mode:0o600,flag:'wx'});
 }
 console.log(removing?'Source removed; databases and agent files retained. Reinstall dependencies and rebuild.':'Source installed. Install dependencies with the frozen lockfile, build and test before starting the host.');
}catch(error){
 for(const [rel,bytes] of before){if(bytes===null){if(fs.existsSync(safe(rel)))fs.unlinkSync(safe(rel))}else fs.writeFileSync(safe(rel),bytes)}
 if(!state&&fs.existsSync(statePath))fs.unlinkSync(statePath);
 throw error;
}
