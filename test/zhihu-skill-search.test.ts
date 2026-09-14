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
