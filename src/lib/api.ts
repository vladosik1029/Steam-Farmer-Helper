import { bridge, type IpcResult } from './bridge';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

// All calls into the app core go through here. Paths keep the old /api/... form.
export async function apiPost<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const result: IpcResult<T> = await bridge().api(path.replace(/^\/api\//, ''), body);
  if (!result.ok) throw new ApiError(result.error || 'Error', result.status || 500, result.code);
  return result.data;
}
