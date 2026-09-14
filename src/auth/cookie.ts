import type { IncomingMessage, ServerResponse } from 'node:http';

export const SESSION_COOKIE = 'z1_session';
export function readCookie(req: IncomingMessage, name: string) {
  const raw = String(req.headers.cookie || '');
  return raw.split(';').map(part => part.trim().split('=' as const)).find(([key]) => key === name)?.[1];
}
export function setSessionCookie(res: ServerResponse, value: string, secure = false) { res.setHeader('set-cookie', `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`); }
export function clearSessionCookie(res: ServerResponse) { res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); }
