import { handleRequest,initialRecord,applyRequest } from './http.mjs';
import { createAppHandler } from './application.mjs';
import { createD1Store } from '@viewherd/server';
import { createSupportState } from '../examples/support-desk/domain.mjs';
import { createStudioState } from '../examples/product-studio/domain.mjs';

export function makeD1Store(db) {
  async function read() {
    let row=await db.prepare('SELECT payload FROM webdr_sessions WHERE id = ?').bind('default').first();
    if(!row){const record=initialRecord();await db.prepare('INSERT OR IGNORE INTO webdr_sessions (id,revision,payload,updated_at) VALUES (?,?,?,?)').bind('default',record.storageRevision,JSON.stringify(record),Date.now()).run();row=await db.prepare('SELECT payload FROM webdr_sessions WHERE id = ?').bind('default').first();}
    return JSON.parse(row.payload);
  }
  return {kind:'cloudflare-d1',read,async transact(body){for(let attempt=0;attempt<6;attempt++){const record=await read();const output=await applyRequest(record,body);if(!output.changed)return output.response;const saved=await db.prepare('UPDATE webdr_sessions SET revision = ?, payload = ?, updated_at = ? WHERE id = ? AND revision = ?').bind(output.record.storageRevision,JSON.stringify(output.record),Date.now(),'default',record.storageRevision ?? record.state.revision).run();if(saved.meta.changes===1)return output.response;}throw Object.assign(new Error('Workspace is busy. Refresh and retry.'),{code:'revision_conflict'});}};
}

export default {
  async fetch(request,env) {
    if(!env.DB)return new Response(JSON.stringify({error:{code:'storage_unavailable',message:'Persistent workspace binding DB is missing.'}}),{status:503,headers:{'content-type':'application/json'}});
    // This deployment is owner-private. Sites dispatch authenticates both browser and MCP/service access.
    // A public multi-tenant deployment must replace this shared room with authorized room/user keys.
    return createAppHandler({
      legacyStore: makeD1Store(env.DB),
      supportStore: createD1Store(env.DB, { createState: createSupportState }),
      studioStore: createD1Store(env.DB, { createState: createStudioState }),
      assets: WEBDR_ASSETS,
      serviceProtected: true,
    })(request);
  }
};
