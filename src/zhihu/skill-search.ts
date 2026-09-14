import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ZhihuSearchItem = Readonly<{
  title: string;
  authorName: string;
  authorSignature?: string;
  excerpt: string;
  url: string;
}>;

export type ZhihuSearchResult = Readonly<{
  items: readonly ZhihuSearchItem[];
  users: readonly ZhihuSearchItem[];
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
  const authorSignature = text(item.AuthorSignature || item.authorSignature || item.author_signature || item.AuthorUrl || item.authorUrl || item.author_url);
  const excerpt = text(item.ContentText || item.contentText || item.excerpt || item.summary || item.Summary);
  const url = text(item.Url || item.url || item.Link || item.link);
  if (title && authorName && url) result.push({ title, authorName, ...(authorSignature ? { authorSignature } : {}), excerpt, url });
  for (const child of Object.values(item)) collectItems(child, result);
  return result;
}

function normalizeAuthor(value: string) {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function parseZhihuSearchItemsOutput(output: string) {
  const payload = JSON.parse(output) as unknown;
  const seenSources = new Set<string>();
  const items: ZhihuSearchItem[] = [];
  for (const item of collectItems(payload)) {
    const authorKey = normalizeAuthor(item.authorSignature || item.authorName);
    const sourceKey = `${authorKey}\u0000${item.url}`;
    if (seenSources.has(sourceKey)) continue;
    seenSources.add(sourceKey);
    items.push(item);
  }
  return items;
}

export function collapseZhihuSearchAuthors(items: readonly ZhihuSearchItem[]) {
  const authors = new Map<string, ZhihuSearchItem>();
  for (const item of items) {
    const authorKey = normalizeAuthor(item.authorSignature || item.authorName);
    // Search returns content records. Collapse them here so callers receive
    // one candidate per real author, with the first result kept as evidence.
    if (!authors.has(authorKey)) authors.set(authorKey, item);
  }
  return [...authors.values()];
}

export function parseZhihuSearchOutput(output: string) {
  return collapseZhihuSearchAuthors(parseZhihuSearchItemsOutput(output));
}

export function zhihuAuthorId(item: Pick<ZhihuSearchItem, 'authorName' | 'authorSignature'>) {
  const identity = item.authorSignature || normalizeAuthor(item.authorName);
  return `zhihu:${Buffer.from(identity).toString('base64url').slice(0, 48)}`;
}

export function zhihuContentId(item: Pick<ZhihuSearchItem, 'url'>) {
  return `zhihu-content:${Buffer.from(item.url).toString('base64url').slice(0, 80)}`;
}

export async function searchZhihu(query: string, count = 10): Promise<ZhihuSearchResult> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery || process.env.ZHIHU_SEARCH_MODE === 'mock') return { items: [], users: [] };
  const cliPath = process.env.ZHIHU_CLI_PATH || defaultCliPath();
  const { stdout } = await execFileAsync(cliPath, ['search', 'zhihu', '--query', normalizedQuery, '--count', String(Math.min(10, Math.max(1, count)))], {
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000
  });
  const items = parseZhihuSearchItemsOutput(stdout);
  return { items, users: collapseZhihuSearchAuthors(items) };
}

export async function searchZhihuUsers(query: string, count = 10): Promise<ZhihuSearchItem[]> {
  const result = await searchZhihu(query, count);
  return [...result.users];
}
