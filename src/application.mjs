import { handleRequest } from './http.mjs';
import { createRegistry } from '@viewherd/core';
import { createViewherdHandler } from '@viewherd/server';
import { createClient } from '@viewherd/client';
import { supportPanels } from '../examples/support-desk/domain.mjs';
import { studioPanels } from '../examples/product-studio/domain.mjs';
import { createStudioAssistantHandler } from '../examples/product-studio/assistant.mjs';
import { createDemoAgent } from '../examples/product-studio/demo-agent.mjs';

const appSupportRegistry = createRegistry(supportPanels);
const appStudioRegistry = createRegistry(studioPanels);

function appHasToken(request, token) {
  if (!token) return true;
  if (request.headers.get('authorization') === `Bearer ${token}`) return true;
  return request.headers.get('cookie')?.split(';').some(part => part.trim() === `webdr_token=${encodeURIComponent(token)}`) === true;
}

/** Reference-app routing. Real applications supply their own authorization adapter. */
export function createAppHandler({ legacyStore, supportStore, studioStore, assets, token, agent = createDemoAgent(), serviceProtected = false }) {
  async function authorize(request, room, sessionId = room) {
    if (sessionId && sessionId !== room) throw Object.assign(new Error('This example only exposes its own session.'), { code: 'forbidden', status: 403 });
    if (!appHasToken(request, token)) throw Object.assign(new Error('Supply this server’s access token.'), { code: 'unauthorized', status: 401 });
    const userId = serviceProtected ? request.headers.get('oai-authenticated-user-id') : null;
    return { id: userId || (serviceProtected ? 'private-site-service' : 'local-user'), actor: userId ? 'human/ui' : 'reference-app', name: 'Studio user', roles: ['owner'] };
  }
  const makeHandler = (registry, store, room, basePath, mcpPath) => createViewherdHandler({
    registry, store, sessionId: room, basePath, mcpPath,
    trustedMcpOrigin: serviceProtected,
    authorize: async (request, { sessionId }) => {
      // This hosted reference app is owner-private. Dispatch authenticates visitors
      // and service callers. It exposes one shared, fictional demo room.
      // Applications replace this adapter with their membership/permission checks.
      return authorize(request, room, sessionId);
    },
  });
  const studioHandler = makeHandler(appStudioRegistry, studioStore, 'product-studio', '/viewherd', '/mcp');
  const supportHandler = makeHandler(appSupportRegistry, supportStore, 'support-desk', '/webdr', '/support/mcp');
  const assistantHandler = createStudioAssistantHandler({
    agent,
    async clientFor(request, { turnId } = {}) {
      const user = await authorize(request, 'product-studio');
      const principal = { ...user, actor: 'agent:studio', roles: [...user.roles, 'studio-agent'], ...(turnId ? { turnId } : {}) };
      // This handler is private to the backend runner. Browsers cannot assign
      // themselves its role, actor, clock, or conversation lease.
      const agentHandler = createViewherdHandler({
        registry: appStudioRegistry, store: studioStore, sessionId: 'product-studio',
        authorize: async (_request, { sessionId }) => {
          if (sessionId !== 'product-studio') throw Object.assign(new Error('This agent only controls the product studio.'), { code: 'forbidden', status: 403 });
          return { ...principal, serverTime: Date.now() };
        },
      });
      const client = createClient({
        baseUrl: new URL('/viewherd', request.url).href,
        sessionId: 'product-studio',
        fetch: (input, init) => agentHandler(new Request(input, init)),
      });
      return { client, principal };
    },
  });
  return async request => {
    const url = new URL(request.url);
    if (url.pathname === '/assistant') return assistantHandler(request);
    if (url.pathname === '/mcp' || url.pathname === '/viewherd' || url.pathname.startsWith('/viewherd/')) return studioHandler(request);
    if (url.pathname === '/support/mcp' || url.pathname === '/webdr' || url.pathname.startsWith('/webdr/')) return supportHandler(request);
    if (url.pathname === '/support' || url.pathname === '/support/') {
      url.pathname = '/support/index.html';
      return handleRequest(new Request(url, request), { store: legacyStore, assets, token, serviceProtected });
    }
    if (url.pathname === '/lab/mcp') {
      url.pathname = '/mcp';
      return handleRequest(new Request(url, request), { store: legacyStore, assets, token, serviceProtected });
    }
    if (url.pathname === '/lab' || url.pathname === '/lab/') {
      url.pathname = '/lab/index.html';
      return handleRequest(new Request(url, request), { store: legacyStore, assets, token, serviceProtected });
    }
    return handleRequest(request, { store: legacyStore, assets, token, serviceProtected });
  };
}
