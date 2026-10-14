import type { SessionStore, StateFactoryOptions } from '@viewherd/server';
/** Local, atomic file adapter. Use one Node process per path; multi-process writers require a database adapter. */
export function createFileStore(options: StateFactoryOptions & { path: string }): SessionStore;
