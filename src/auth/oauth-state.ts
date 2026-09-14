import { randomBytes } from 'node:crypto';

type PendingState = { sessionId: string; expiresAt: number };
export class OAuthStateStore {
  private readonly states = new Map<string, PendingState>();
  create(sessionId: string, ttlMs = 10 * 60 * 1000) { const value = randomBytes(32).toString('hex'); this.states.set(value, { sessionId, expiresAt: Date.now() + ttlMs }); return value; }
  consume(value: string | null, sessionId: string) { if (!value) return false; const pending = this.states.get(value); this.states.delete(value); return Boolean(pending && pending.sessionId === sessionId && pending.expiresAt > Date.now()); }
}
