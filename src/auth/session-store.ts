import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { readCookie } from './cookie.ts';
import type { ZhihuOAuthToken, ZhihuUser } from '../zhihu/types.ts';

type Session = { id: string; createdAt: number; user?: ZhihuUser; accessToken?: string; refreshToken?: string; tokenExpiresAt?: number };
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  getOrCreate(req: IncomingMessage) { const id = readCookie(req, 'z1_session') || randomUUID(); let session = this.sessions.get(id); if (!session) { session = { id, createdAt: Date.now() }; this.sessions.set(id, session); } return session; }
  get(id: string) { return this.sessions.get(id); }
  setToken(id: string, token: ZhihuOAuthToken, user: ZhihuUser) { const session = this.sessions.get(id) || { id, createdAt: Date.now() }; session.user = user; session.accessToken = token.accessToken; session.refreshToken = token.refreshToken; session.tokenExpiresAt = token.expiresIn ? Date.now() + token.expiresIn * 1000 : undefined; this.sessions.set(id, session); return session; }
  delete(id: string) { this.sessions.delete(id); }
  publicView(session?: Session) { return { authenticated: Boolean(session?.user), mode: session?.user ? 'real' : 'demo', user: session?.user || null }; }
}
