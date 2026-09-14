import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeA2ASessionAdapter, InMemoryF05InvitationDraftPort, type A2ASessionAdapter } from '../src/a2a-adapter.ts';
import { buildAgentContextSnapshot } from '../src/agent-context.ts';
import { createA2ASession, runA2ASession, type RecommendationSnapshot } from '../src/a2a-session.ts';

function profile(ownerId: string, boundaries: ('public' | 'private')[] = ['public', 'private', 'public']) {
  return buildAgentContextSnapshot({ profileVersion: 2, profileConfirmedAt: '2026-09-14T00:00:00.000Z', impressions: [`${ownerId}公开讨论AI产品入口实践。`, `${ownerId}不希望分享这段私密项目经历。`, `${ownerId}愿意围绕真实证据交流取舍。`], profileSourceReferences: [[`${ownerId}:1`], [`${ownerId}:private`], [`${ownerId}:3`]], profilePublicBoundaries: boundaries }, ownerId);
}

const recommendation: RecommendationSnapshot = Object.freeze({ recommendationId: 'recommendation:2:person:candidate', ownerId: 'requester', candidateId: 'candidate', targetType: 'person', query: 'AI 产品入口取舍', profileVersion: 2, verdict: 'recommended', a2aEligible: true, a2aReasons: ['RECOMMENDED_MATCH'], evidenceRefs: [{ sourceType: 'candidate', sourceId: 'candidate', excerpt: '候选人的公开实践摘要', quality: 'self_reported' }], createdAt: '2026-09-14T00:00:00.000Z' });

test('runs exactly three evidence-bounded rounds and produces an F05 handoff', async () => {
  const initial = createA2ASession(recommendation, profile('requester'), profile('candidate'));
  assert.equal(initial.status, 'created');
  const f05 = new InMemoryF05InvitationDraftPort();
  const states: string[] = [];
  const result = await runA2ASession(initial, new FakeA2ASessionAdapter('proceed'), f05, session => states.push(`${session.status}:${session.currentRound}`));
  assert.equal(result.status, 'completed');
  assert.equal(result.currentRound, 3);
  assert.equal(result.turns.length, 6);
  assert.deepEqual(result.turns.map(turn => `${turn.round}:${turn.speaker}`), ['1:requester_agent', '1:candidate_agent', '2:requester_agent', '2:candidate_agent', '3:requester_agent', '3:candidate_agent']);
  assert.ok(result.turns.every(turn => turn.claims.every(claim => claim.evidenceRefIds.length > 0)));
  assert.equal(result.observation?.verdict, 'proceed');
  assert.ok(result.f05Handoff);
  assert.equal(f05.payloads.length, 1);
  assert.ok(states.includes('observing:3'));
  assert.ok(states.includes('running:1'));
  assert.ok(states.includes('running:2'));
  assert.ok(states.includes('running:3'));
});

test('bounds retained payloads in the fake F05 port', async () => {
  const f05 = new InMemoryF05InvitationDraftPort();
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), new FakeA2ASessionAdapter('proceed'), f05);
  assert.ok(result.f05Handoff);
  for (let index = 0; index < 500; index += 1) await f05.createDraft(result.f05Handoff);
  assert.equal(f05.payloads.length, 500);
});

test('rejects a Recommendation that is not eligible for A2A', () => {
  assert.throws(() => createA2ASession({ ...recommendation, a2aEligible: false }, profile('requester'), profile('candidate')), /A2A_NOT_ELIGIBLE/);
});

test('never puts private Profile sections into the evidence ledger', () => {
  const session = createA2ASession(recommendation, profile('requester'), profile('candidate'));
  assert.equal(session.evidenceLedger.entries.some(item => item.excerpt.includes('私密项目经历')), false);
});

test('fails when a factual claim references evidence outside the ledger', async () => {
  const invalidAdapter: A2ASessionAdapter = {
    async generateTurn() { return { intent: 'position', text: '无依据事实', claims: [{ text: '无依据事实', evidenceRefIds: ['missing'] }], questions: [] }; },
    async observe() { return { verdict: 'stop', reason: '不会执行到这里。', reasonCodes: ['INSUFFICIENT_EVIDENCE'], evidenceRefs: ['missing'] }; }
  };
  const f05 = new InMemoryF05InvitationDraftPort();
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), invalidAdapter, f05);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'A2A_CLAIM_EVIDENCE_INVALID');
  assert.equal(f05.payloads.length, 0);
});

test('completes a stop observation without producing an F05 handoff', async () => {
  const f05 = new InMemoryF05InvitationDraftPort();
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), new FakeA2ASessionAdapter('stop'), f05);
  assert.equal(result.status, 'completed');
  assert.equal(result.observation?.verdict, 'stop');
  assert.equal(result.f05Handoff, undefined);
  assert.equal(f05.payloads.length, 0);
});

test('produces an F05 handoff when the Observer needs user review', async () => {
  const f05 = new InMemoryF05InvitationDraftPort();
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), new FakeA2ASessionAdapter('needs_user_review'), f05);
  assert.equal(result.observation?.verdict, 'needs_user_review');
  assert.equal(result.f05Handoff?.observerVerdict, 'needs_user_review');
  assert.equal(f05.payloads.length, 1);
});

test('does not produce a handoff when the Observer only cites one side', async () => {
  const base = new FakeA2ASessionAdapter('proceed');
  const adapter: A2ASessionAdapter = {
    generateTurn: request => base.generateTurn(request),
    async observe(request) { const evidence = request.evidenceLedger.entries.find(item => item.owner === 'requester')!; return { verdict: 'proceed', reason: '只有单方证据。', reasonCodes: ['ONE_SIDED_EVIDENCE'], evidenceRefs: [evidence.id] }; }
  };
  const f05 = new InMemoryF05InvitationDraftPort();
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), adapter, f05);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'A2A_OBSERVATION_EVIDENCE_INSUFFICIENT');
  assert.equal(f05.payloads.length, 0);
});

test('rejects malformed runtime output from a replaceable Adapter', async () => {
  const adapter: A2ASessionAdapter = {
    async generateTurn() { return { intent: 'invented', text: '非法输出', claims: [], questions: [] } as never; },
    async observe() { return { verdict: 'proceed', reason: '不会执行。', reasonCodes: ['MUTUAL_TOPIC_ALIGNMENT'], evidenceRefs: [] }; }
  };
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), adapter, new InMemoryF05InvitationDraftPort());
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'A2A_TURN_INVALID');
});

test('rejects claims that cite the other Agent evidence', async () => {
  const base = new FakeA2ASessionAdapter();
  const adapter: A2ASessionAdapter = {
    async generateTurn(request) { const otherOwner = request.speaker === 'requester_agent' ? 'candidate' : 'requester'; const evidence = request.evidenceLedger.entries.find(item => item.owner === otherOwner)!; return { intent: request.round === 1 ? 'position' : request.round === 2 ? 'response' : 'summary', text: evidence.excerpt, claims: [{ text: evidence.excerpt, evidenceRefIds: [evidence.id] }], questions: request.round === 2 ? ['请回应。'] : [] }; },
    observe: request => base.observe(request)
  };
  const f05 = new InMemoryF05InvitationDraftPort();
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), adapter, f05);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'A2A_CLAIM_EVIDENCE_INVALID');
  assert.equal(f05.payloads.length, 0);
});

test('rejects a proceed verdict that explicitly reports insufficient evidence', async () => {
  const base = new FakeA2ASessionAdapter();
  const adapter: A2ASessionAdapter = {
    generateTurn: request => base.generateTurn(request),
    async observe(request) { return { verdict: 'proceed', reason: '证据不足。', reasonCodes: ['INSUFFICIENT_EVIDENCE'], evidenceRefs: request.evidenceLedger.entries.filter(item => item.owner === 'requester' || item.owner === 'candidate').slice(0, 2).map(item => item.id) }; }
  };
  const f05 = new InMemoryF05InvitationDraftPort();
  const result = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), adapter, f05);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'A2A_OBSERVATION_EVIDENCE_INSUFFICIENT');
  assert.equal(f05.payloads.length, 0);
});

test('does not execute an A2A Session twice', async () => {
  const f05 = new InMemoryF05InvitationDraftPort();
  const completed = await runA2ASession(createA2ASession(recommendation, profile('requester'), profile('candidate')), new FakeA2ASessionAdapter(), f05);
  await assert.rejects(() => runA2ASession(completed, new FakeA2ASessionAdapter(), f05), /A2A_SESSION_STATE_INVALID/);
  assert.equal(f05.payloads.length, 1);
});
