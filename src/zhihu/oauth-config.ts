export type ZhihuOAuthConfig = {
  appId: string;
  appKey: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  accessSecret: string;
  configured: boolean;
};

export function readZhihuOAuthConfig(env = process.env): ZhihuOAuthConfig {
  const appId = env.ZHIHU_OAUTH_APP_ID || '';
  const appKey = env.ZHIHU_OAUTH_APP_KEY || '';
  const redirectUri = env.ZHIHU_OAUTH_REDIRECT_URI || 'http://localhost:3000/auth/zhihu/callback';
  const authorizeUrl = env.ZHIHU_OAUTH_AUTHORIZE_URL || 'https://openapi.zhihu.com/authorize';
  const tokenUrl = env.ZHIHU_OAUTH_TOKEN_URL || 'https://openapi.zhihu.com/access_token';
  const accessSecret = env.ZHIHU_ACCESS_SECRET || '';
  return { appId, appKey, redirectUri, authorizeUrl, tokenUrl, accessSecret, configured: Boolean(appId && appKey && redirectUri) };
}
