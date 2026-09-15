import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

async function waitForServer(baseUrl: string, child: ReturnType<typeof spawn>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

function cookieFrom(response: Response) {
  return response.headers.get('set-cookie')?.split(';')[0] || '';
}

const profileState = {
  version: 1,
  profileVersion: 3,
  profileConfirmedAt: '2026-09-14T00:00:00.000Z',
  step: 'done',
  name: '测试用户',
  impressions: [
    '我关注 AI 产品入口与真实交互取舍，希望从具体案例开始交流。',
    '我会亲自验证产品方案，也愿意分享用户访谈与实践经验。',
    '我想认识愿意基于证据讨论产品问题的人。'
  ],
  profileSourceReferences: [['测试回答 1'], ['测试回答 2'], ['测试回答 3']],
  profilePublicBoundaries: ['public', 'public', 'public'],
  skills: [{ id: 'skill-discovery-test', name: '寻找 AI 产品同路人', kind: 'people', goal: '寻找 AI 产品与交互实践经验。', keywords: 'AI 产品 交互', enabled: true }],
  following: [],
  liked: [],
  saved: [],
  chats: {},
  runs: [],
  discoverIds: [],
  contentIds: [],
  feedIds: [],
  lastView: 'discover',
  agentChats: {}
};

test('a Skill run persists Zhihu people, content, feed data, and supports A2A', async () => {
  const port = await availablePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'z1space-skill-discovery-'));
  const cliPath = join(dataDir, 'zhihu-cli');
  await writeFile(cliPath, `#!/usr/bin/env node
const longExcerpt = '长摘要'.repeat(200);
process.stdout.write(JSON.stringify({Data:[
  {Title:'AI 产品实战复盘',AuthorName:'知乎用户甲',AuthorSignature:'zhihu-user-a',ContentText:longExcerpt,Url:'https://www.zhihu.com/question/1/answer/2'},
  {Title:'独立产品的用户访谈方法',AuthorName:'知乎用户乙',AuthorSignature:'zhihu-user-b',ContentText:'记录真实用户访谈和产品迭代。',Url:'https://zhuanlan.zhihu.com/p/3'}
]}));\n`);
  await chmod(cliPath, 0o755);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), Z1SPACE_DATA_DIR: dataDir, ZHIHU_CLI_PATH: cliPath, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseHeaders = { 'content-type': 'application/json' };

  try {
    await waitForServer(baseUrl, child);
    const saved = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: baseHeaders, body: JSON.stringify(profileState) });
    assert.equal(saved.status, 200);
    const cookie = cookieFrom(saved);
    assert.ok(cookie.startsWith('z1space_session='));
    const headers = { ...baseHeaders, cookie };

    const started = await fetch(`${baseUrl}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ skill: profileState.skills[0] }) });
    assert.equal(started.status, 202);
    const initialRun = await started.json() as { id: string };
    assert.ok(initialRun.id);

    let run: any = initialRun;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/runs/${initialRun.id}`, { headers });
      assert.equal(response.status, 200);
      run = await response.json();
      if (run.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(run.status, 'completed');
    assert.ok(run.matches.length >= 2);
    assert.ok(run.contentMatches.length >= 2);
    const personId = run.matches[0];
    const contentId = run.contentMatches[0];
    assert.equal(run.people[personId].source, 'zhihu');
    assert.equal(run.posts[contentId].source, 'zhihu');
    assert.match(run.posts[contentId].url, /^https:\/\//);

    const state = await (await fetch(`${baseUrl}/api/state`, { headers })).json() as any;
    assert.ok(state.people[personId]);
    assert.ok(state.posts[contentId]);
    assert.ok(state.discoverIds.includes(personId));
    assert.ok(state.contentIds.includes(contentId));
    assert.ok(state.feedIds.includes(personId));

    const person = run.people[personId];
    const discoveredPeople = await (await fetch(`${baseUrl}/api/discover/people?q=${encodeURIComponent(person.topic)}&limit=10`, { headers })).json() as any;
    const recommendation = discoveredPeople.recommendations.find((item: any) => item.targetId === personId);
    assert.ok(recommendation);
    assert.ok(recommendation.a2aEligible);

    const discoveredContent = await (await fetch(`${baseUrl}/api/discover/content?q=${encodeURIComponent(run.posts[contentId].title)}&limit=10`, { headers })).json() as any;
    assert.ok(discoveredContent.candidates.some((item: any) => item.id === contentId));

    const a2aStarted = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: recommendation.id, idempotencyKey: 'skill-discovery-a2a' }) });
    assert.equal(a2aStarted.status, 202);
    const a2aInitial = await a2aStarted.json() as { id: string };
    let a2a: any = a2aInitial;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/a2a-sessions/${a2aInitial.id}`, { headers });
      assert.equal(response.status, 200);
      a2a = await response.json();
      if (a2a.status === 'completed' || a2a.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(a2a.status, 'completed');
    assert.equal(a2a.turns.length, 6);
    assert.ok(a2a.observation);

    const directA2aStarted = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ runId: initialRun.id, candidateId: personId, idempotencyKey: 'skill-discovery-direct-a2a' }) });
    assert.equal(directA2aStarted.status, 202);
    const directA2aInitial = await directA2aStarted.json() as { id: string };
    let directA2a: any = directA2aInitial;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/a2a-sessions/${directA2aInitial.id}`, { headers });
      assert.equal(response.status, 200);
      directA2a = await response.json();
      if (directA2a.status === 'completed' || directA2a.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(directA2a.status, 'completed');
    assert.deepEqual(directA2a.turns.map((turn: any) => turn.speaker), ['requester_agent', 'candidate_agent', 'requester_agent', 'candidate_agent', 'requester_agent', 'candidate_agent']);

    const persistedStateA2aStarted = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ candidateId: personId, idempotencyKey: 'skill-discovery-persisted-a2a' }) });
    assert.equal(persistedStateA2aStarted.status, 202);
    const persistedStateA2a = await persistedStateA2aStarted.json() as { id: string };
    const persistedStateA2aResult = await (await fetch(`${baseUrl}/api/a2a-sessions/${persistedStateA2a.id}`, { headers })).json() as any;
    assert.ok(['created', 'running', 'observing', 'completed'].includes(persistedStateA2aResult.status));

    const secondSaved = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: baseHeaders, body: JSON.stringify({ ...profileState, name: '第二个用户' }) });
    assert.equal(secondSaved.status, 200);
    const secondHeaders = { ...baseHeaders, cookie: cookieFrom(secondSaved) };
    const secondPeople = await (await fetch(`${baseUrl}/api/discover/people?q=${encodeURIComponent(person.topic)}&limit=10`, { headers: secondHeaders })).json() as any;
    assert.equal(secondPeople.candidates.some((item: any) => item.id === personId), false);
    const secondContent = await (await fetch(`${baseUrl}/api/discover/content?q=${encodeURIComponent(run.posts[contentId].title)}&limit=10`, { headers: secondHeaders })).json() as any;
    assert.equal(secondContent.candidates.some((item: any) => item.id === contentId), false);
  } finally {
    child.kill();
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('marks a Skill run failed when Zhihu search is unavailable', async () => {
  const port = await availablePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'z1space-skill-discovery-failure-'));
  const cliPath = join(dataDir, 'zhihu-cli');
  await writeFile(cliPath, `#!/usr/bin/env node
console.error('知乎搜索 API 返回错误 30001');
process.exit(1);
`);
  await chmod(cliPath, 0o755);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), Z1SPACE_DATA_DIR: dataDir, ZHIHU_CLI_PATH: cliPath, ZHIHU_ACCESS_SECRET: '', DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseHeaders = { 'content-type': 'application/json' };

  try {
    await waitForServer(baseUrl, child);
    const saved = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: baseHeaders, body: JSON.stringify(profileState) });
    assert.equal(saved.status, 200);
    const headers = { ...baseHeaders, cookie: cookieFrom(saved) };

    const started = await fetch(`${baseUrl}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ skill: profileState.skills[0] }) });
    assert.equal(started.status, 202);
    const initialRun = await started.json() as { id: string };

    let run: any = initialRun;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/runs/${initialRun.id}`, { headers });
      assert.equal(response.status, 200);
      run = await response.json();
      if (run.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(run.status, 'failed');
    assert.equal(run.searchError, true);
    assert.match(run.llmError, /知乎搜索 API 返回错误 30001/);
    assert.equal(run.matches.length, 0);
    assert.equal(run.contentMatches.length, 0);
    assert.equal(run.timeline.some((item: any) => item.text.includes('没有找到符合条件')), false);
  } finally {
    child.kill();
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
