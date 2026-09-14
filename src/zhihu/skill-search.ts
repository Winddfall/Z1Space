import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ZhihuSearchItem = Readonly<{
  title: string;
  authorName: string;
  excerpt: string;
  url: string;
}>;

function defaultCliPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'zhihu-cli', 'current', 'zhihu-cli');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'zhihu-cli', 'current', 'zhihu-cli');
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function collectItems(value: unknown, result: ZhihuSearchItem[] = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectItems(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  const item = value as Record<string, unknown>;
  const title = text(item.Title || item.title);
  const authorName = text(item.AuthorName || item.authorName || item.author_name || item.author);
  const excerpt = text(item.ContentText || item.contentText || item.excerpt || item.summary || item.Summary);
  const url = text(item.Url || item.url || item.Link || item.link);
  if (title && authorName && url) result.push({ title, authorName, excerpt, url });
  for (const child of Object.values(item)) collectItems(child, result);
  return result;
}

export function parseZhihuSearchOutput(output: string) {
  const payload = JSON.parse(output) as unknown;
  const seen = new Set<string>();
  return collectItems(payload).filter(item => {
    const key = `${item.authorName}\u0000${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchZhihuUsers(query: string, count = 10): Promise<ZhihuSearchItem[]> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  if (process.env.ZHIHU_SEARCH_MODE === 'mock') return [];
  const cliPath = process.env.ZHIHU_CLI_PATH || defaultCliPath();
  const { stdout } = await execFileAsync(cliPath, ['search', 'zhihu', '--query', normalizedQuery, '--count', String(Math.min(10, Math.max(1, count)))], {
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000
  });
  return parseZhihuSearchOutput(stdout);
}
