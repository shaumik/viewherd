import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
const fixture = await mkdtemp(join(tmpdir(), 'viewherd-sdk-adoption-'));
try {
  await writeFile(resolve(fixture, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const archives = ['core', 'client', 'dom', 'server'].map(name => resolve(root, `artifacts/npm/viewherd-${name}-${version}.tgz`));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', resolve(root, 'artifacts/.npm-cache'), ...archives], { cwd: fixture, stdio: 'pipe' });
  await writeFile(resolve(fixture, 'verify.mjs'), `
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {definePanel,createRegistry,createSession} from '@viewherd/core';
import {createClient} from '@viewherd/client';
import {mountWorkspace} from '@viewherd/dom';
import {createViewherdHandler,createMemoryStore} from '@viewherd/server';
import {createFileStore} from '@viewherd/server/node';
globalThis.crypto ??= webcrypto;
assert.equal(typeof mountWorkspace,'function');
assert.equal(typeof createFileStore,'function');
const counter=definePanel({type:'counter',title:'Counter',dataSchema:{type:'object',properties:{count:{type:'integer'}},required:['count'],additionalProperties:false},actions:{increment:{inputSchema:{type:'object',properties:{},additionalProperties:false},run(ctx){ctx.app.count++;ctx.call('view.update',{paneId:ctx.pane.id,data:{count:ctx.app.count}});return {count:ctx.app.count};}}}});
const registry=createRegistry([counter]);
const store=createMemoryStore({createState:id=>createSession({id,view:'counter',data:{count:0},app:{count:0},registry})});
const handler=createViewherdHandler({registry,store,sessionId:'adoption',authorize:()=>({id:'fixture-user'}),stream:{pollIntervalMs:10,lifetimeMs:500,heartbeatMs:100}});
const client=createClient({baseUrl:'https://fixture.test/viewherd',sessionId:'adoption',fetch:(url,init)=>handler(new Request(url,init))});
try {
  assert.equal((await client.snapshot()).app.count,0);
  const result=await client.call('panel.action',{paneId:'pane_inbox',action:'increment',args:{}},{requestId:'increment-1',expectedRevision:0});
  assert.equal(result.result.count,1);
  const retry=await client.call('panel.action',{paneId:'pane_inbox',action:'increment',args:{}},{requestId:'increment-1',expectedRevision:0});
  assert.equal(retry.replayed,true);assert.equal(retry.state.app.count,1);
  let unsubscribe;
  const streamed=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('SSE did not deliver the external command')),1500);unsubscribe=client.subscribe(state=>{if(state.revision===2){clearTimeout(timeout);resolve(state);}});});
  const external=await handler(new Request('https://fixture.test/viewherd/rpc',{method:'POST',body:JSON.stringify({version:1,requestId:'increment-2',sessionId:'adoption',method:'panel.action',params:{paneId:'pane_inbox',action:'increment',args:{}}})}));
  assert.equal(external.status,200);assert.equal((await streamed).app.count,2);unsubscribe();
  console.log('All four packed SDK packages install independently; custom app action, retry and live SSE sync verified.');
} finally {client.destroy();}
`);
  process.stdout.write(execFileSync(process.execPath, [resolve(fixture, 'verify.mjs')], { cwd: fixture, encoding: 'utf8', timeout: 10000 }));
} finally { await rm(fixture, { recursive: true, force: true }); }
