import { bridge, type IpcResult } from './bridge';

// Local data (accounts, proxies, history) kept by the main process in the profile folder

type Collection = 'accounts' | 'proxies' | 'logs';

async function call<T = void>(op: string, body: Record<string, unknown>): Promise<T> {
  const result: IpcResult<T> = await bridge().store(op, body);
  if (!result.ok) throw new Error(result.error || 'Local data error');
  return result.data;
}

export const listDocs = <T>(collection: Collection) => call<T[]>('list', { collection });

export const setDoc = (
  collection: 'accounts' | 'proxies',
  id: string,
  data: Record<string, unknown>,
  opts: { merge?: boolean; unset?: string[] } = {}
) => call('set', { collection, id, data, ...opts });

export const deleteDoc = (collection: 'accounts' | 'proxies', id: string) => call('delete', { collection, id });

export const addLogDoc = (entry: Record<string, unknown>) => call('addLog', { entry });

export const onStoreChanged = (listener: (collection: Collection) => void) =>
  bridge().onStoreChanged((c) => listener(c as Collection));
