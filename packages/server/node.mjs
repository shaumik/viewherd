import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession } from '@viewherd/core';

const sdkNodeQueues = new Map();
const sdkNodeClone = value => JSON.parse(JSON.stringify(value));
const sdkNodeFail = message => Object.assign(new Error(message), { code: 'storage_error', status: 503 });

/** Atomic local file persistence for a single Node process. Multiple adapters in this process share a queue. */
export function createFileStore({ path, createState = id => createSession({ id }) } = {}) {
  if (typeof path !== 'string' || !path || typeof createState !== 'function') throw new TypeError('A file path and createState function are required.');
  const file = resolve(path);
  const serialize = run => {
    const operation = (sdkNodeQueues.get(file) ?? Promise.resolve()).then(run);
    const tail = operation.catch(() => {});
    sdkNodeQueues.set(file, tail);
    tail.finally(() => { if (sdkNodeQueues.get(file) === tail) sdkNodeQueues.delete(file); });
    return operation;
  };
  const load = async () => {
    try {
      const database = JSON.parse(await readFile(file, 'utf8'));
      if (database.version !== 1 || !database.sessions || typeof database.sessions !== 'object' || Array.isArray(database.sessions)) throw sdkNodeFail('Invalid Viewherd session file.');
      return database;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, sessions: {} };
      throw error.code === 'storage_error' ? error : sdkNodeFail('Unable to read the Viewherd session file.');
    }
  };
  const save = async database => {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(database), 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, file);
    } catch {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw sdkNodeFail('Unable to persist the Viewherd session file.');
    }
  };
  const sessionId = value => {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value)) throw Object.assign(new Error('Invalid sessionId.'), { code: 'invalid_session', status: 400 });
    return value;
  };
  const ensure = async (database, id) => {
    if (!Object.hasOwn(database.sessions, id)) {
      const state = sdkNodeClone(await createState(id));
      if (state.sessionId !== id || !Number.isSafeInteger(state.revision) || state.revision < 0 || Buffer.byteLength(JSON.stringify(state)) > 900000) throw sdkNodeFail('createState must return a valid session under 900 KB with the requested sessionId.');
      Object.defineProperty(database.sessions, id, { value: { state, receipts: [], storageRevision: 0 }, enumerable: true, writable: true, configurable: true });
      await save(database);
    }
    const record = database.sessions[id];
    if (record.state?.sessionId !== id || !Number.isSafeInteger(record.storageRevision) || !Array.isArray(record.receipts)) throw sdkNodeFail('Invalid persisted session record.');
    return record;
  };
  return {
    kind: 'local-file',
    read(id) {
      sessionId(id);
      return serialize(async () => { const database = await load(); return sdkNodeClone(await ensure(database, id)); });
    },
    transact(id, transaction) {
      sessionId(id);
      if (typeof transaction !== 'function') throw new TypeError('transaction must be a function.');
      return serialize(async () => {
        const database = await load(), original = await ensure(database, id);
        const output = await transaction(sdkNodeClone(original));
        if (!output?.record || typeof output.changed !== 'boolean' || output.record.state?.sessionId !== id || !Number.isSafeInteger(output.record.storageRevision)) throw sdkNodeFail('Transaction must return a valid {record, response, changed}.');
        if (output.changed) {
          if (output.record.storageRevision !== original.storageRevision + 1 || Buffer.byteLength(JSON.stringify(output.record.state)) > 900000) throw sdkNodeFail('Stored transactions must advance storageRevision once and keep state under 900 KB.');
          database.sessions[id] = sdkNodeClone(output.record);
          await save(database);
        }
        return sdkNodeClone(output.response);
      });
    }
  };
}
