import type { HelperContext } from '../types';

const API_BASE = '';

async function req(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}`);
  return res.json();
}

export const fetchContext = (): Promise<HelperContext> => req('/api/context');

export function pushContext(patch: Partial<HelperContext>): Promise<HelperContext> {
  return req('/api/context', { method: 'POST', body: JSON.stringify(patch) });
}

/** Upload (or clear, with null) the waypoint stage background. Returns fresh url or null. */
export async function uploadStageBg(dataUrl: string | null): Promise<string | null> {
  const res = await fetch('/api/stage-bg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl }),
  });
  if (!res.ok) throw new Error(`POST /api/stage-bg -> ${res.status}`);
  const { url } = await res.json();
  return url ? `${url}?v=${Date.now()}` : null;
}

/** Debounced push helper — returns a function you call with the latest patch. */
export function createContextPusher(delayMs = 400) {
  let t: ReturnType<typeof setTimeout> | undefined;
  let pending: Partial<HelperContext> = {};
  let listeners: Array<(s: 'syncing' | 'saved' | 'error') => void> = [];
  const onStatus = (fn: (s: 'syncing' | 'saved' | 'error') => void) => {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter((l) => l !== fn);
    };
  };
  const emit = (s: 'syncing' | 'saved' | 'error') => listeners.forEach((l) => l(s));
  const push = (patch: Partial<HelperContext>) => {
    pending = { ...pending, ...patch };
    emit('syncing');
    if (t) clearTimeout(t);
    t = setTimeout(async () => {
      const body = pending;
      pending = {};
      try {
        await pushContext(body);
        emit('saved');
      } catch {
        emit('error');
      }
    }, delayMs);
  };
  return { push, onStatus };
}
