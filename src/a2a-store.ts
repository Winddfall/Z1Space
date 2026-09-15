import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type A2AStoredState = Readonly<{ sessions: Record<string, unknown>; idempotency: Record<string, string>; deliveries: Record<string, unknown> }>;

export class A2AStateStore {
  private readonly filePath: string;
  private readonly databaseUrl: string;
  private pool: { query: (text: string, values?: unknown[]) => Promise<{ rows: { value: A2AStoredState }[] }> ; end: () => Promise<void> } | null = null;
  constructor(filePath: string, databaseUrl = process.env.DATABASE_URL || '') { this.filePath = filePath; this.databaseUrl = databaseUrl; }

  private async db() {
    if (!this.databaseUrl) return null;
    if (!this.pool) {
      const pg = await import('pg') as { Pool: new (options: Record<string, unknown>) => typeof this.pool };
      this.pool = new pg.Pool({ connectionString: this.databaseUrl, max: 2, ...(process.env.DATABASE_SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}) });
      await this.pool!.query('CREATE TABLE IF NOT EXISTS z1space_a2a_state (id text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())');
    }
    return this.pool;
  }

  async load(): Promise<A2AStoredState | null> {
    const db = await this.db();
    if (db) { const result = await db.query('SELECT value FROM z1space_a2a_state WHERE id = $1', ['global']); return result.rows[0]?.value || null; }
    try { return JSON.parse(await readFile(this.filePath, 'utf8')) as A2AStoredState; } catch { return null; }
  }

  async save(value: A2AStoredState) {
    const db = await this.db();
    if (db) { await db.query('INSERT INTO z1space_a2a_state (id, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()', ['global', JSON.stringify(value)]); return; }
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2));
    await rename(temporary, this.filePath);
  }
}
