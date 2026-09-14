import assert from 'node:assert/strict';
import test from 'node:test';
import { parseZhihuSearchOutput, zhihuAuthorId } from '../src/zhihu/skill-search.ts';

test('parses real Zhihu search authors and removes duplicate results', () => {
  const results = parseZhihuSearchOutput(JSON.stringify({
    Data: [
      { Title: '北京大厂实习经验', AuthorName: '真实用户甲', AuthorSignature: 'real-user-a', ContentText: '分享实习准备和面试经历', Url: 'https://www.zhihu.com/question/1/answer/2' },
      { Title: '同一作者的另一条经验', AuthorName: '真实用户甲', AuthorSignature: 'real-user-a', ContentText: '补充经历', Url: 'https://www.zhihu.com/question/1/answer/3' },
      { Title: '另一条经验', AuthorName: '真实用户乙', ContentText: '实习信息', Url: 'https://zhuanlan.zhihu.com/p/4' }
    ]
  }));
  assert.deepEqual(results.map(item => item.authorName), ['真实用户甲', '真实用户乙']);
  assert.equal(results[0].title, '北京大厂实习经验');
  assert.equal(results[1].url, 'https://zhuanlan.zhihu.com/p/4');
  assert.equal(zhihuAuthorId(results[0]), 'zhihu:cmVhbC11c2VyLWE');
});

test('falls back to the Zhihu HTTP search API when the CLI is unavailable', async () => {
  const previousCliPath = process.env.ZHIHU_CLI_PATH;
  const previousAccessSecret = process.env.ZHIHU_ACCESS_SECRET;
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  process.env.ZHIHU_CLI_PATH = '/tmp/z1space-missing-zhihu-cli';
  process.env.ZHIHU_ACCESS_SECRET = 'test-secret';
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestHeaders = init?.headers;
    return new Response(JSON.stringify({ Data: [{ Title: 'HTTP 搜索结果', AuthorName: '线上用户', AuthorSignature: 'online-user', ContentText: '来自开放平台搜索接口', Url: 'https://www.zhihu.com/question/5/answer/6' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const { searchZhihu } = await import('../src/zhihu/skill-search.ts');
    const result = await searchZhihu('AI 产品', 3);
    assert.equal(result.items.length, 1);
    assert.equal(result.users[0].authorName, '线上用户');
    assert.equal(new URL(requestUrl).pathname, '/api/v1/content/zhihu_search');
    assert.equal(new URL(requestUrl).searchParams.get('Query'), 'AI 产品');
    assert.equal(new URL(requestUrl).searchParams.get('Count'), '3');
    const headers = new Headers(requestHeaders);
    assert.equal(headers.get('authorization'), 'Bearer test-secret');
    assert.ok(headers.get('x-request-timestamp'));
  } finally {
    if (previousCliPath === undefined) delete process.env.ZHIHU_CLI_PATH;
    else process.env.ZHIHU_CLI_PATH = previousCliPath;
    if (previousAccessSecret === undefined) delete process.env.ZHIHU_ACCESS_SECRET;
    else process.env.ZHIHU_ACCESS_SECRET = previousAccessSecret;
    globalThis.fetch = originalFetch;
  }
});
