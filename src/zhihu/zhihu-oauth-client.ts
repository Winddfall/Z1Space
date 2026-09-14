import type { ZhihuOAuthConfig } from './oauth-config.ts';
import type { ZhihuOAuthToken, ZhihuUser } from './types.ts';

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
  return record.data && typeof record.data === 'object' ? asRecord(record.data) : record;
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
