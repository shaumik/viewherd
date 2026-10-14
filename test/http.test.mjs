import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {applyRequest,initialRecord,handleRequest} from '../src/http.mjs';
globalThis.crypto ??= webcrypto;

function memoryStore(){let record=initialRecord();return{kind:'test-memory',read:async()=>record,async transact(body){const output=await applyRequest(record,body);record=output.record;return output.response;}};}
const request=(path,body,headers={})=>new Request(`http://localhost:4317${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});

test('request IDs prevent duplicate creates and reject reuse for different operations',async()=>{
 const record=initialRecord();const body={id:'retry-create',method:'workspace.create',params:{label:'Idempotent'}};
 const first=await applyRequest(record,body);const second=await applyRequest(first.record,body);
 assert.equal(second.changed,false);assert.equal(second.response.replayed,true);assert.equal(second.response.result.workspaceId,first.response.result.workspaceId);assert.equal(second.record.state.workspaces.length,2);
 await assert.rejects(()=>applyRequest(first.record,{...body,params:{label:'Different'}}),{code:'id_conflict'});
});
test('retrying an earlier no-op cannot undo a later human action',async()=>{
 const store=memoryStore();const request={id:'agent-unzoom',method:'pane.zoom',params:{paneId:'pane_brief',enabled:false}};
 await store.transact(request);await store.transact({id:'human-zoom',method:'pane.zoom',params:{paneId:'pane_brief',enabled:true}});
 const replay=await store.transact(request);assert.equal(replay.replayed,true);assert.equal((await store.read()).state.workspaces[0].tabs[0].zoomedPaneId,'pane_brief');assert.equal(replay.revision,1);
});
test('stale revision cannot change state and returns current state for recovery',async()=>{
 const store=memoryStore();await store.transact({id:'advance',method:'workspace.create',params:{label:'Other client'}});
 const response=await handleRequest(request('/api/rpc',{id:'stale',method:'workspace.create',params:{label:'Would overwrite'},expectedRevision:0}),{store,assets:{}});
 assert.equal(response.status,409);const body=await response.json();assert.equal(body.error.code,'revision_conflict');assert.equal(body.state.revision,1);assert.equal(body.state.workspaces.length,2);
});
test('MCP tools operate on the same state as browser REST',async()=>{
 const store=memoryStore();const result=await handleRequest(request('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'webdr_call',arguments:{method:'workspace.create',params:{label:'Created by MCP'}}}}),{store,assets:{}});
 assert.equal(result.status,200);const rpc=await result.json();assert.equal(rpc.result.isError,undefined);
 const state=await (await handleRequest(request('/api/state'),{store,assets:{}})).json();assert.equal(state.workspaces.at(-1).label,'Created by MCP');assert.equal(state.events.at(-1).actor,'agent:mcp');
});
test('cross-origin writes rejected and previews remain isolated',async()=>{
 const store=memoryStore();const cross=await handleRequest(request('/api/rpc',{id:'cross',method:'workspace.create',params:{label:'Cross'}},{origin:'https://evil.example'}),{store,assets:{}});assert.equal(cross.status,403);assert.equal((await store.read()).state.revision,0);
 const pane=Object.values((await store.read()).state.panes).find(p=>p.view==='preview');
 const response=await handleRequest(request('/api/preview/'+pane.id),{store,assets:{}});assert.equal(response.status,200);const csp=response.headers.get('content-security-policy');assert.match(csp,/sandbox allow-scripts/);assert.doesNotMatch(csp,/allow-same-origin/);assert.match(csp,/form-action 'none'/);
});
test('large or malformed bodies fail without mutation',async()=>{
 const store=memoryStore();const malformed=new Request('http://localhost:4317/api/rpc',{method:'POST',body:'{oops'});const response=await handleRequest(malformed,{store,assets:{}});assert.equal(response.status,400);assert.equal((await response.json()).error.code,'invalid_json');assert.equal((await store.read()).state.revision,0);
 const oversized=new Request('http://localhost:4317/api/rpc',{method:'POST',body:' '.repeat(300001)});const limit=await handleRequest(oversized,{store,assets:{}});assert.equal(limit.status,400);assert.equal((await limit.json()).error.code,'body_limit');
});
test('optional local token protects both API and browser while allowing login',async()=>{
 const store=memoryStore(),options={store,assets:{},token:'test-only-access-token'};
 assert.equal((await handleRequest(request('/api/state'),options)).status,401);
 const loginPage=await handleRequest(request('/'),options);assert.match(await loginPage.text(),/Connect to Webdr/);
 const login=await handleRequest(new Request('http://localhost:4317/api/auth',{method:'POST',headers:{origin:'http://localhost:4317'},body:'token=test-only-access-token'}),options);assert.equal(login.status,303);assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
 const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await handleRequest(request('/api/state',null,{cookie}),options)).status,200);
 assert.equal((await handleRequest(request('/api/state',null,{authorization:'Bearer test-only-access-token'}),options)).status,200);
});
test('one controller pane can create, edit, rearrange and delete another while surviving',async()=>{
 const store=memoryStore();let seq=0;
 const call=async(method,params)=>store.transact({id:`controller-test-${++seq}`,method,params});
 const created=await call('workspace.create',{label:'Panel control QA',view:'api',title:'Controller'});
 const source=created.result.paneId,actor=`panel:${source}`;
 const split=await call('pane.split',{actor,paneId:source,direction:'right',view:'document',title:'Target',data:{content:'# Target'}});
 const target=split.result.paneId;
 await call('view.update',{actor,paneId:source,data:{targetPaneId:target}});
 await call('view.action',{actor,paneId:target,action:'append',args:{content:'\nWritten from the controller.'}});
 assert.match((await store.read()).state.panes[target].data.content,/Written from the controller/);
 await call('view.open',{actor,paneId:target,view:'tasks',data:{items:[{id:'cross-panel',text:'Complete from another panel',done:false}]}});
 await call('view.action',{actor,paneId:target,action:'toggle',args:{id:'cross-panel',done:true}});
 assert.equal((await store.read()).state.panes[target].data.items[0].done,true);
 await call('pane.move',{actor,paneId:target,targetPaneId:source,direction:'down'});
 await call('pane.close',{actor,paneId:target});
 const state=(await store.read()).state;
 assert.equal(state.panes[target],undefined);assert.equal(state.panes[source].view,'api');
 assert.equal(state.workspaces.at(-1).tabs[0].layout.paneId,source);
 assert.ok(state.events.filter(e=>e.actor===actor).length>=7);
});
