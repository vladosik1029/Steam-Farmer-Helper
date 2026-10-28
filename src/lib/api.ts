import { auth } from './firebase';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

// All server calls go through here: attaches the Firebase ID token the server checks
export async function apiPost<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new ApiError('Not signed in', 401);

  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Server error (${res.status})`, res.status, data.code);
  return data as T;
}
