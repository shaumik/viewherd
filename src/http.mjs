import { createInitialState, execute, API_METHODS, VIEW_SCHEMAS, LIMITS } from './core.mjs';

const httpJson = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
const httpFail = (code, message) => Object.assign(new Error(message), {code});
export const initialRecord = () => ({state:createInitialState(), receipts:[],storageRevision:0});
const READ_METHODS = new Set(['session.snapshot','api.schema','workspace.list','tab.list','pane.list','pane.get']);

async function fingerprint(body) {
  const bytes = new TextEncoder().encode(JSON.stringify([body.method,body.params ?? {},body.expectedRevision]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
}

export async function applyRequest(record, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.method !== 'string') throw httpFail('invalid_request','Provide {id, method, params}.');
  if (body.id !== undefined && (typeof body.id !== 'string' || !body.id.length || body.id.length > 128)) throw httpFail('invalid_request','Request id must be a non-empty string under 129 characters.');
  if (body.params !== undefined && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) throw httpFail('invalid_request','params must be an object.');
  if (body.expectedRevision !== undefined && (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0)) throw httpFail('invalid_request','expectedRevision must be a non-negative integer.');
  const hash = await fingerprint(body);
  const cached = body.id && record.receipts.find(r=>r.id===body.id);
  if (cached) {
    if (cached.hash !== hash) throw httpFail('id_conflict','This request id was already used for a different operation.');
    return {record, changed:false, response:{id:body.id,result:cached.result,revision:record.state.revision,state:record.state,replayed:true}};
  }
  if (body.expectedRevision !== undefined && body.expectedRevision !== record.state.revision) throw httpFail('revision_conflict','Workspace changed. Refresh state and retry with a new request id.');
  const output = execute(record.state, body.method, body.params ?? {});
  if (new TextEncoder().encode(JSON.stringify(output.state)).byteLength > 900000) throw httpFail('state_limit','Workspace storage limit reached. Remove unused content before adding more.');
  let receipts = record.receipts;
  const remember = !!body.id && !READ_METHODS.has(body.method);
  if (remember) {
    let result = output.result;
    if (JSON.stringify(result).length > 16000) result = Object.fromEntries(Object.entries(result).filter(([k])=>/Id$|^id$|^changed$/.test(k)));
    receipts = [...receipts,{id:body.id,hash,result}].slice(-24);
    while(new TextEncoder().encode(JSON.stringify(receipts)).byteLength > 200000) receipts.shift();
  }
  const storageChanged=output.changed || remember;
  return {record:{state:output.state,receipts,storageRevision:(record.storageRevision ?? record.state.revision)+(storageChanged?1:0)},changed:storageChanged,response:{id:body.id ?? null,result:output.result,revision:output.state.revision,state:output.state}};
}

export const MCP_TOOLS = [
  {name:'webdr_snapshot',description:'Read the current Webdr workspaces, tabs, pane layouts, view content and agent states.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'webdr_schema',description:'Discover the available Webdr API operations and parameter schemas.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'webdr_call',description:'Control the live Webdr web workspace: create workspaces/tabs, split/resize/move/zoom panes, edit views and report agent status. Call webdr_schema first for operation parameters. Uses the same state as the visible UI.',inputSchema:{type:'object',properties:{method:{type:'string'},params:{type:'object'},id:{type:'string',description:'Stable request ID for retries.'},requestId:{type:'string',description:'Alias for id.'},expectedRevision:{type:'integer',minimum:0}},required:['method'],additionalProperties:false}}
];

async function mcp(request, store) {
  const body = await readBody(request);
  const response = result => httpJson({jsonrpc:'2.0',id:body.id ?? null,result});
  if(body.method?.startsWith('notifications/')) return new Response(null,{status:202});
  if(body.method==='server/discover') return response({supportedVersions:['2026-07-28','2025-03-26','2024-11-05'],capabilities:{tools:{}}});
  if(body.method==='initialize') return response({protocolVersion:body.params?.protocolVersion ?? '2025-03-26',capabilities:{tools:{}},serverInfo:{name:'webdr',version:'0.1.0'}});
  if(body.method==='ping') return response({});
  if(body.method==='tools/list') return response({tools:MCP_TOOLS});
  if(body.method!=='tools/call') return httpJson({jsonrpc:'2.0',id:body.id ?? null,error:{code:-32601,message:'Method not found'}},400);
  try {
    const args=body.params?.arguments ?? {};
    let result;
    if(body.params.name==='webdr_snapshot') result=(await store.read()).state;
    else if(body.params.name==='webdr_schema') result={methods:API_METHODS,viewSchemas:VIEW_SCHEMAS,limits:LIMITS};
    else if(body.params.name==='webdr_call') result=await store.transact({id:args.id ?? args.requestId ?? crypto.randomUUID(),method:args.method,params:{...args.params,actor:args.params?.actor ?? 'agent:mcp'},...(args.expectedRevision===undefined?{}:{expectedRevision:args.expectedRevision})});
    else throw httpFail('unknown_tool','Unknown Webdr tool.');
    return response({content:[{type:'text',text:JSON.stringify(result)}]});
  } catch(error) {return response({isError:true,content:[{type:'text',text:JSON.stringify({error:{code:error.code ?? 'internal_error',message:error.message}})}]});}
}

async function readBody(request) {
  const reader=request.body?.getReader();
  if(!reader) throw httpFail('invalid_request','Request body is required.');
  let bytes=0; const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>300000){await reader.cancel();throw httpFail('body_limit','Request body exceeds 300 KB.');}chunks.push(value);}
  const data=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(data));}catch{throw httpFail('invalid_json','Request body must be valid JSON.');}
}

export async function handleRequest(request, {store, assets, token, serviceProtected=false}) {
  const url=new URL(request.url);
  try {
    const origin=request.headers.get('origin');
    if(origin && origin!==url.origin && !(serviceProtected && url.pathname==='/mcp')) return httpJson({error:{code:'origin_rejected',message:'Use the same origin as this Webdr server.'}},403);
    if(token && url.pathname==='/api/auth' && request.method==='POST') {
      const text=await request.text();
      if(text.length>2048)return httpJson({error:{code:'invalid_request',message:'Invalid token.'}},400);
      if(new URLSearchParams(text).get('token')!==token)return new Response('Token did not match. Return to Webdr and try again.',{status:401});
      return new Response(null,{status:303,headers:{location:'/', 'set-cookie':`webdr_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${url.protocol==='https:'?'; Secure':''}`}});
    }
    if(token && request.headers.get('authorization')!==`Bearer ${token}` && request.headers.get('cookie')?.split(';').map(s=>s.trim()).includes(`webdr_token=${encodeURIComponent(token)}`)!==true) {
      if(url.pathname==='/' && request.method==='GET')return new Response('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Webdr · Connect</title><style>body{background:#10151d;color:#eef3fa;font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(340px,80vw)}h1{letter-spacing:-.04em}p{color:#9aa9bf}input,button{box-sizing:border-box;width:100%;padding:14px;margin:8px 0;border-radius:8px;border:1px solid #344153;font:inherit}input{background:#19222f;color:white}button{background:#67e8cb;font-weight:700;cursor:pointer}</style><form method="post" action="/api/auth"><h1>Connect to Webdr</h1><p>Enter this server\'s access token.</p><input type="password" name="token" aria-label="Server access token" autocomplete="current-password" required><button>Open workspace</button></form></html>',{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
      return httpJson({error:{code:'unauthorized',message:'Supply the Webdr bearer token.'}},401);
    }
    if(url.pathname==='/api/health') return httpJson({name:'webdr',version:'0.1.0',storage:store.kind,serviceProtected});
    if(url.pathname==='/api/state' && request.method==='GET') return httpJson((await store.read()).state);
    if(url.pathname==='/api/schema' && request.method==='GET') return httpJson({methods:API_METHODS,viewSchemas:VIEW_SCHEMAS,limits:LIMITS});
    if(url.pathname.startsWith('/api/preview/') && request.method==='GET') {
      const id=decodeURIComponent(url.pathname.slice('/api/preview/'.length));
      const pane=(await store.read()).state.panes[id];
      if(!pane || pane.view!=='preview')return httpJson({error:{code:'not_found',message:'Preview pane not found.'}},404);
      return new Response(pane.data.html ?? '',{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; base-uri 'none'; form-action 'none'",'referrer-policy':'no-referrer'}});
    }
    if(url.pathname==='/api/events' && request.method==='GET') {
      const state=(await store.read()).state;const after=Number(url.searchParams.get('after')??0);
      return httpJson({revision:state.revision,events:state.events.filter(e=>e.revision>after),resetRequired:state.events.length>0 && after<state.events[0].revision-1});
    }
    if(url.pathname==='/api/rpc' && request.method==='POST') {
      let body;
      try{body=await readBody(request); return httpJson(await store.transact(body));}
      catch(error){const status=error.code==='revision_conflict'||error.code==='id_conflict'?409:400;return httpJson({id:body?.id??null,error:{code:error.code??'invalid_request',message:error.message},state:(await store.read()).state},status);}
    }
    if(url.pathname==='/mcp' && request.method==='POST') return await mcp(request,store);
    const path=url.pathname==='/'?'/index.html':url.pathname;
    const asset=assets[path];
    if(asset && (request.method==='GET'||request.method==='HEAD')) return new Response(request.method==='HEAD'?null:asset.content,{headers:{'content-type':asset.type,'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'same-origin','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'"}});
    return httpJson({error:{code:'not_found',message:'Route not found.'}},404);
  }catch(error){return httpJson({error:{code:'service_error',message:error.message}},503);}
}
