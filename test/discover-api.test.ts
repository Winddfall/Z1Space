import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { goldenProfileState, goldenSessionId } from './fixtures/golden-case.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function waitForServer(baseUrl: string, child: ReturnType<typeof spawn>) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not start');
}

test('Discover APIs complete the Golden Case and preserve empty results', async () => {
  const port = await availablePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'z1space-discover-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'src/server.ts'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), Z1SPACE_DATA_DIR: dataDir, DEEPSEEK_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const baseHeaders = { 'content-type': 'application/json' };

  try {
    await waitForServer(baseUrl, child);
    const saved = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: baseHeaders, body: JSON.stringify(goldenProfileState) });
    assert.equal(saved.status, 200);
    const cookie = saved.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie?.startsWith('z1space_session='));
    assert.match(saved.headers.get('set-cookie') || '', /HttpOnly; SameSite=Strict/);
    const headers = { ...baseHeaders, cookie };

    const peopleResponse = await fetch(`${baseUrl}/api/discover/people?skill_id=golden-people-skill&limit=3`, { headers });
    assert.equal(peopleResponse.status, 200);
    const people = await peopleResponse.json() as { target: string; candidates: { id: string }[]; recommendations: { id: string; targetId: string; reason: string; metrics: Record<string, number>; verdict: string; evidenceRefs: unknown[]; a2aEligible: boolean; a2aReasons: string[] }[] };
    assert.equal(people.target, 'people');
    assert.deepEqual(people.candidates.map(candidate => candidate.id), ['chen', 'xia', 'zhou']);
    assert.equal(people.recommendations.length, 3);
    for (const recommendation of people.recommendations) {
      assert.ok(recommendation.reason);
      assert.deepEqual(Object.keys(recommendation.metrics), ['topicRelevance', 'informationGain', 'explorableDivergence', 'evidenceStrength']);
      assert.ok(['recommended', 'consider', 'not_recommended'].includes(recommendation.verdict));
      assert.ok(recommendation.evidenceRefs.length > 0);
      assert.equal(typeof recommendation.a2aEligible, 'boolean');
      assert.ok(recommendation.a2aReasons.length > 0);
    }

    const contentResponse = await fetch(`${baseUrl}/api/discover/content?q=${encodeURIComponent('知识管理')}`, { headers });
    assert.equal(contentResponse.status, 200);
    const content = await contentResponse.json() as { candidates: { id: string }[]; recommendations: { id: string; evidenceRefs: { sourceType: string }[] }[] };
    assert.deepEqual(content.candidates.map(candidate => candidate.id), ['p5']);
    assert.deepEqual(content.recommendations[0].evidenceRefs.map(item => item.sourceType), ['content']);

    const eligible = people.recommendations.find(item => item.a2aEligible);
    assert.ok(eligible);

    const repeatedDiscoverResponse = await fetch(`${baseUrl}/api/discover/people?skill_id=golden-people-skill&limit=3`, { headers });
    const repeatedDiscover = await repeatedDiscoverResponse.json() as { recommendations: { id: string; targetId: string }[] };
    const repeatedCandidate = repeatedDiscover.recommendations.find(item => item.targetId === eligible.targetId);
    assert.ok(repeatedCandidate);
    assert.notEqual(repeatedCandidate.id, eligible.id);

    const otherSaved = await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers: baseHeaders, body: JSON.stringify(goldenProfileState) });
    const otherCookie = otherSaved.headers.get('set-cookie')?.split(';')[0];
    assert.ok(otherCookie);
    const otherHeaders = { ...baseHeaders, cookie: otherCookie };
    assert.equal((await fetch(`${baseUrl}/api/discover/people?skill_id=golden-people-skill`, { headers: otherHeaders })).status, 200);

    const a2aResponse = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'golden-a2a' }) });
    assert.equal(a2aResponse.status, 202);
    const createdA2A = await a2aResponse.json() as { id: string; status: string };
    assert.ok(createdA2A.id);

    const duplicateA2AResponse = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'golden-a2a' }) });
    assert.equal(duplicateA2AResponse.status, 202);
    assert.equal((await duplicateA2AResponse.json() as { id: string }).id, createdA2A.id);

    const concurrentResponses = await Promise.all([1, 2].map(() => fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'concurrent-a2a' }) })));
    assert.deepEqual(concurrentResponses.map(response => response.status), [202, 202]);
    const concurrentBodies = await Promise.all(concurrentResponses.map(response => response.json() as Promise<{ id: string }>));
    assert.equal(concurrentBodies[0].id, concurrentBodies[1].id);

    let completedA2A: { status: string; turns: unknown[]; observation?: { verdict: string; reason: string; evidenceRefs: string[] }; f05Handoff?: unknown } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/a2a-sessions/${createdA2A.id}`, { headers });
      completedA2A = await response.json() as typeof completedA2A;
      if (completedA2A?.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(completedA2A?.status, 'completed');
    assert.equal(completedA2A?.turns.length, 6);
    assert.equal(completedA2A?.observation?.verdict, 'proceed');
    assert.ok(completedA2A?.observation?.reason);
    assert.ok(completedA2A?.observation?.evidenceRefs.length);
    assert.ok(completedA2A?.f05Handoff);

    const unauthorizedA2A = await fetch(`${baseUrl}/api/a2a-sessions/${createdA2A.id}`, { headers: baseHeaders });
    assert.equal(unauthorizedA2A.status, 404);

    const nonEligibleA2A = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: content.recommendations[0].id, idempotencyKey: 'content-a2a' }) });
    assert.equal(nonEligibleA2A.status, 409);
    assert.deepEqual(await nonEligibleA2A.json(), { error: 'A2A_NOT_ELIGIBLE' });

    const emptyResponse = await fetch(`${baseUrl}/api/discover/people?q=${encodeURIComponent('量子农业')}`, { headers });
    assert.equal(emptyResponse.status, 200);
    const empty = await emptyResponse.json() as { candidates: unknown[]; recommendations: unknown[] };
    assert.deepEqual(empty.candidates, []);
    assert.deepEqual(empty.recommendations, []);

    const invalidProfileResponse = await fetch(`${baseUrl}/api/discover/people?q=AI`, { headers: baseHeaders });
    assert.equal(invalidProfileResponse.status, 409);
    assert.deepEqual(await invalidProfileResponse.json(), { error: 'PROFILE_NOT_CONFIRMED' });

    const missingSkillResponse = await fetch(`${baseUrl}/api/discover/people?skill_id=missing`, { headers });
    assert.equal(missingSkillResponse.status, 400);
    assert.deepEqual(await missingSkillResponse.json(), { error: 'SKILL_NOT_FOUND' });

    const runResponse = await fetch(`${baseUrl}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ skill: goldenProfileState.skills[0] }) });
    assert.equal(runResponse.status, 202);
    const run = await runResponse.json() as { id: string; status: string; profileVersion: number; matches: string[] };
    assert.ok(run.id);
    assert.equal(run.status, 'running');
    assert.equal(run.profileVersion, 3);
    assert.deepEqual(run.matches, ['chen', 'xia']);

    const spoofedRunResponse = await fetch(`${baseUrl}/api/runs/${run.id}`, { headers: { ...baseHeaders, 'x-z1-session': goldenSessionId } });
    assert.equal(spoofedRunResponse.status, 404);

    const missingRunResponse = await fetch(`${baseUrl}/api/discover/people?run_id=missing`, { headers });
    assert.equal(missingRunResponse.status, 404);
    assert.deepEqual(await missingRunResponse.json(), { error: 'RUN_NOT_FOUND' });

    const reusedResponse = await fetch(`${baseUrl}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ skill: goldenProfileState.skills[0] }) });
    assert.equal(reusedResponse.status, 202);
    const reused = await reusedResponse.json() as { id: string };
    assert.equal(reused.id, run.id);

    await new Promise(resolve => setTimeout(resolve, 2_000));
    const restartedResponse = await fetch(`${baseUrl}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ skill: goldenProfileState.skills[0] }) });
    assert.equal(restartedResponse.status, 202);
    const restarted = await restartedResponse.json() as { id: string; status: string };
    assert.notEqual(restarted.id, run.id);
    assert.equal(restarted.status, 'running');

    const progressedResponse = await fetch(`${baseUrl}/api/runs/${run.id}`, { headers });
    assert.equal(progressedResponse.status, 200);
    const progressed = await progressedResponse.json() as { status: string; stage: number; timeline: { text: string }[] };
    assert.equal(progressed.status, 'completed');
    assert.equal(progressed.stage, 3);
    assert.ok(progressed.timeline.some(item => item.text.includes('理解你的目标')));
    assert.ok(progressed.timeline.some(item => item.text.includes('有结果了')));

    const changedProfile = { ...goldenProfileState, profileVersion: 4 };
    assert.equal((await fetch(`${baseUrl}/api/state`, { method: 'PUT', headers, body: JSON.stringify(changedProfile) })).status, 200);
    const repeatedAfterProfileChange = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'golden-a2a' }) });
    assert.equal(repeatedAfterProfileChange.status, 202);
    assert.equal((await repeatedAfterProfileChange.json() as { id: string }).id, createdA2A.id);
    const staleRecommendation = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'stale-profile' }) });
    assert.equal(staleRecommendation.status, 409);
    assert.deepEqual(await staleRecommendation.json(), { error: 'PROFILE_VERSION_CHANGED' });

    const churnResponses = await Promise.all(Array.from({ length: 34 }, () => fetch(`${baseUrl}/api/discover/people?skill_id=golden-people-skill&limit=3`, { headers })));
    const expiredRecommendation = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'evicted-snapshot' }) });
    assert.equal(expiredRecommendation.status, 404);
    assert.deepEqual(await expiredRecommendation.json(), { error: 'RECOMMENDATION_NOT_FOUND' });

    const retryAfterSnapshotEviction = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'golden-a2a' }) });
    assert.equal(retryAfterSnapshotEviction.status, 202);
    assert.equal((await retryAfterSnapshotEviction.json() as { id: string }).id, createdA2A.id);

    const oversizedRequest = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: eligible.id, idempotencyKey: 'x'.repeat(2_100) }) });
    assert.equal(oversizedRequest.status, 413);
    assert.deepEqual(await oversizedRequest.json(), { error: 'REQUEST_TOO_LARGE' });

    const latestDiscover = await churnResponses.at(-1)!.json() as { recommendations: { id: string; a2aEligible: boolean }[] };
    const retainedRecommendation = latestDiscover.recommendations.find(item => item.a2aEligible);
    assert.ok(retainedRecommendation);
    let firstBoundedSessionId = '';
    for (let index = 0; index < 21; index += 1) {
      const response = await fetch(`${baseUrl}/api/a2a-sessions`, { method: 'POST', headers, body: JSON.stringify({ recommendationId: retainedRecommendation.id, idempotencyKey: `bounded-${index}` }) });
      assert.equal(response.status, 202);
      const created = await response.json() as { id: string };
      if (!firstBoundedSessionId) firstBoundedSessionId = created.id;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await fetch(`${baseUrl}/api/a2a-sessions/${created.id}`, { headers });
        if (current.status === 200 && ['completed', 'failed'].includes((await current.json() as { status: string }).status)) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    assert.equal((await fetch(`${baseUrl}/api/a2a-sessions/${firstBoundedSessionId}`, { headers })).status, 404);
  } finally {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});
