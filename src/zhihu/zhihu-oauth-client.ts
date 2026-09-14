import type { ZhihuOAuthConfig } from './oauth-config.ts';
import type { ZhihuOAuthToken, ZhihuUser, ZhihuUserData } from './types.ts';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function readJson(response: Response) {
  const raw = await response.text();
  if (!response.ok) throw new Error(`知乎接口返回 HTTP ${response.status}`);
  const normalized = raw.replace(/(\"uid\"\s*:\s*)(-?\d+)/g, '$1\"$2\"');
  const payload = JSON.parse(normalized || '{}') as unknown;
  const record = asRecord(payload);
  if (typeof record.code === 'number' && record.code !== 0 && record.code !== 20000) throw new Error('知乎接口返回错误');
  const data = record.data ?? record.Data;
  return data && typeof data === 'object' ? asRecord(data) : record;
}

export function authorizationUrl(config: ZhihuOAuthConfig, state: string) {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('app_id', config.appId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeCode(config: ZhihuOAuthConfig, code: string): Promise<ZhihuOAuthToken> {
  const form = new URLSearchParams({ app_id: config.appId, app_key: config.appKey, grant_type: 'authorization_code', redirect_uri: config.redirectUri, code });
  const payload = await fetch(config.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }).then(readJson);
  const accessToken = String(payload.access_token || '');
  if (!accessToken) throw new Error('知乎未返回 access token');
  return { accessToken, tokenType: String(payload.token_type || 'Bearer'), expiresIn: Number(payload.expires_in) || undefined, refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined };
}

export async function fetchUser(accessToken: string): Promise<ZhihuUser> {
  const payload = await fetch('https://openapi.zhihu.com/user', { headers: { authorization: `Bearer ${accessToken}` } }).then(readJson);
  const rawId = payload.uid ?? payload.id ?? payload.hash_id;
  const id = rawId === undefined || rawId === null ? '' : String(rawId);
  if (!id || !String(payload.fullname || '').trim()) throw new Error('知乎用户资料缺少必要字段');
  return { id, hashId: typeof payload.hash_id === 'string' ? payload.hash_id : undefined, fullname: String(payload.fullname), gender: typeof payload.gender === 'string' ? payload.gender : undefined, headline: typeof payload.headline === 'string' ? payload.headline : undefined, description: typeof payload.description === 'string' ? payload.description : undefined, avatarPath: typeof payload.avatar_path === 'string' ? payload.avatar_path : undefined, url: typeof payload.url === 'string' ? payload.url : undefined };
}


async function fetchUserDataEndpoint(accessSecret: string, accessToken: string, path: string, params: Record<string, string>) {
  const url = new URL(`https://developer.zhihu.com/api/v1/user/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessSecret}`, 'x-oauth-token': accessToken, 'x-request-timestamp': String(Math.floor(Date.now() / 1000)), 'content-type': 'application/json' } });
  return readJson(response);
}

function listPayload(payload: Record<string, unknown>) {
  const data = asRecord(payload.data ?? payload.Data ?? payload);
  const items = Array.isArray(data.Items) ? data.Items : (Array.isArray(data.items) ? data.items : []);
  const paging = asRecord(data.Paging ?? data.paging);
  const total = Number(paging.Totals);
  return { items, total: Number.isFinite(total) ? total : undefined };
}

export async function fetchUserData(accessSecret: string, accessToken: string): Promise<ZhihuUserData> {
  if (!accessSecret) return {};
  const [allResult, answersResult, articlesResult, followeesResult] = await Promise.allSettled([
    fetchUserDataEndpoint(accessSecret, accessToken, 'contents', { ContentType: 'all', Limit: '50', SortField: 'ts', SortOrder: 'desc' }),
    fetchUserDataEndpoint(accessSecret, accessToken, 'contents', { ContentType: 'answer', Limit: '1', SortField: 'ts', SortOrder: 'desc' }),
    fetchUserDataEndpoint(accessSecret, accessToken, 'contents', { ContentType: 'article', Limit: '1', SortField: 'ts', SortOrder: 'desc' }),
    fetchUserDataEndpoint(accessSecret, accessToken, 'followees', { Limit: '1' })
  ]);
  const result: ZhihuUserData = {};
  if (allResult.status === 'fulfilled') {
    const list = listPayload(allResult.value);
    result.contentCount = list.total;
    result.contentItems = list.items.map(item => { const row = asRecord(item); return { contentType: String(row.ContentType || '').toLowerCase(), title: String(row.Title || ''), summary: String(row.Summary || ''), url: String(row.Url || '') }; });
  }
  if (answersResult.status === 'fulfilled') result.answerCount = listPayload(answersResult.value).total;
  if (articlesResult.status === 'fulfilled') result.articleCount = listPayload(articlesResult.value).total;
  if (followeesResult.status === 'fulfilled') result.followeeCount = listPayload(followeesResult.value).total;
  return result;
}
