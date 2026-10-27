import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import {auditDistribution,buildArchive} from '../release.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const release=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const upstream=process.env.NANOCLAW_TEST_UPSTREAM;
if(!upstream)throw Error('Set NANOCLAW_TEST_UPSTREAM to a local upstream Git checkout');
const commit=JSON.parse(fs.readFileSync(path.join(release,'compatibility.json'))).upstreamCommit;
const owned=JSON.parse(fs.readFileSync(path.join(release,'manifest.json')));
const base=JSON.parse(fs.readFileSync(path.join(release,'base-files.json')));
const scratch=path.join(upstream,'.cache');fs.mkdirSync(scratch,{recursive:true});
function fixture(){const root=fs.mkdtempSync(path.join(scratch,'native-install-'));const archive=execFileSync('git',['-C',upstream,'archive',commit],{maxBuffer:100*1024*1024});assert.equal(spawnSync('tar',['-xf','-','-C',root],{input:archive}).status,0);execFileSync('git',['init','-q',root]);return root;}
const run=(root,...args)=>spawnSync(process.execPath,[path.join(release,'install.mjs'),'--target',root,...args],{encoding:'utf8'});
const ok=r=>assert.equal(r.status,0,r.stdout+r.stderr);
const snapshot=root=>Object.fromEntries([...owned,...Object.keys(base)].map(f=>[f,fs.existsSync(path.join(root,f))?createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex'):null]));
test('preflight, install, repeat, retained data and byte-exact removal',()=>{const root=fixture();const before=snapshot(root);ok(run(root,'--check'));assert.deepEqual(snapshot(root),before);ok(run(root,'--apply'));const after=snapshot(root);ok(run(root,'--apply'));assert.deepEqual(snapshot(root),after);fs.mkdirSync(path.join(root,'data'),{recursive:true});fs.writeFileSync(path.join(root,'data/v2.db'),'synthetic retained data');assert.notEqual(run(root,'--remove').status,0);ok(run(root,'--check-remove'));ok(run(root,'--remove','--confirm-runtime-retired'));assert.deepEqual(snapshot(root),before);assert.equal(fs.readFileSync(path.join(root,'data/v2.db'),'utf8'),'synthetic retained data');});
test('edited upstream fails before writes',()=>{const root=fixture();fs.appendFileSync(path.join(root,'package.json'),' ');const before=snapshot(root);assert.notEqual(run(root,'--apply').status,0);assert.deepEqual(snapshot(root),before);});
test('owned-file collision refuses overwrite',()=>{const root=fixture();const f=path.join(root,owned[0]);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,'user code');const before=snapshot(root);assert.notEqual(run(root,'--apply').status,0);assert.deepEqual(snapshot(root),before);});
test('dangling symlink is rejected',()=>{const root=fixture();const f=path.join(root,owned[0]);fs.mkdirSync(path.dirname(f),{recursive:true});fs.symlinkSync(path.join(root,'missing'),f);const result=run(root,'--apply');assert.notEqual(result.status,0);assert.match(result.stderr,/symlink/);});
test('edited installed code prevents destructive removal',()=>{const root=fixture();ok(run(root,'--apply'));fs.appendFileSync(path.join(root,owned[0]),'\n// local edit\n');const before=snapshot(root);assert.notEqual(run(root,'--remove').status,0);assert.deepEqual(snapshot(root),before);});

test('live host socket prevents source mutation',async()=>{const root=fixture();fs.mkdirSync(path.join(root,'data'));const server=net.createServer(c=>c.end());await new Promise(r=>server.listen(path.join(root,'data/ncl.sock'),r));try{const before=snapshot(root);const result=run(root,'--apply');assert.notEqual(result.status,0);assert.match(result.stderr,/Stop the target host/);assert.deepEqual(snapshot(root),before);}finally{await new Promise(r=>server.close(r));}});
test('release archive is reproducible and allowlisted',()=>{const files=auditDistribution(release);assert.deepEqual(buildArchive(files,release),buildArchive(files,release));});
