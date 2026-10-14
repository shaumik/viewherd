import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {makeD1Store} from '../src/worker-entry.mjs';
globalThis.crypto ??=webcrypto;

function fakeD1(){let row=null;return{prepare(sql){return{bind(...args){return{async first(){await Promise.resolve();return row?{payload:row.payload}:null;},async run(){await Promise.resolve();if(sql.startsWith('INSERT')){if(!row)row={revision:args[1],payload:args[2]};return{meta:{changes:1}};}if(sql.startsWith('UPDATE')){if(row.revision!==args[4])return{meta:{changes:0}};row={revision:args[0],payload:args[1]};return{meta:{changes:1}};}throw Error('Unknown test query');}};}};}};}

test('independent Worker adapters share durable state and concurrent changes are preserved',async()=>{
 const db=fakeD1(),clientA=makeD1Store(db),clientB=makeD1Store(db);
 await clientA.read();
 await Promise.all([clientA.transact({id:'client-a',method:'workspace.create',params:{label:'A'}}),clientB.transact({id:'client-b',method:'workspace.create',params:{label:'B'}})]);
 const record=await clientB.read();assert.equal(record.state.revision,2);assert.equal(record.state.workspaces.length,3);assert.deepEqual(record.state.workspaces.slice(1).map(w=>w.label).sort(),['A','B']);
 const retry=await clientA.transact({id:'client-a',method:'workspace.create',params:{label:'A'}});assert.equal(retry.replayed,true);assert.equal((await clientA.read()).state.workspaces.length,3);
});
test('explicit revision protects an agent from acting on stale layout',async()=>{
 const store=makeD1Store(fakeD1());await store.transact({id:'a',method:'workspace.create',params:{label:'A'},expectedRevision:0});
 await assert.rejects(()=>store.transact({id:'b',method:'workspace.create',params:{label:'B'},expectedRevision:0}),{code:'revision_conflict'});assert.equal((await store.read()).state.revision,1);
});
test('concurrent no-op receipts use a separate CAS generation without lost history',async()=>{
 const db=fakeD1(),a=makeD1Store(db),b=makeD1Store(db);await a.read();
 await Promise.all([a.transact({id:'noop-a',method:'pane.zoom',params:{paneId:'pane_brief',enabled:false}}),b.transact({id:'noop-b',method:'pane.zoom',params:{paneId:'pane_brief',enabled:false}})]);
 const record=await a.read();assert.equal(record.state.revision,0);assert.equal(record.storageRevision,2);assert.deepEqual(record.receipts.map(r=>r.id).sort(),['noop-a','noop-b']);
});
