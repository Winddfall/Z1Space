import assert from 'node:assert/strict';
import test from 'node:test';
import type { A2AAdapter, A2AEvaluationRequest } from '../src/a2a-adapter.ts';
import { buildAgentContextSnapshot } from '../src/agent-context.ts';
import { recallContent, recallPeople } from '../src/explore.ts';
import { isTriggerEvent, routeTrigger, type RouterContext, type TriggerEvent } from '../src/trigger-router.ts';

const profile = buildAgentContextSnapshot({
  profileConfirmedAt: '2026-09-14T00:00:00.000Z',
  impressions: [
    '关注具体问题和产品取舍。',
    '愿意动手验证技术想法。',
    '希望与人平等交流经验。'
  ],
  profilePublicBoundaries: ['public', 'public', 'public']
}, 'user-1');

const context: RouterContext = {
  actorId: 'user-1',
  profile,
  skills: [{ id: 'people-skill', kind: 'people', enabled: true }]
};

function event(type: TriggerEvent['type'], payload: Record<string, unknown>): TriggerEvent {
  return {
    schemaVersion: 1,
    eventId: 'event-1',
    type,
    occurredAt: '2026-09-14T00:00:00.000Z',
    source: 'web',
    actor: { userId: 'user-1' },
    correlationId: 'correlation-1',
    payload
  };
}

test('accepts a valid TriggerEvent', () => {
  assert.equal(isTriggerEvent(event('explore.requested', { target: 'people' })), true);
});

test('builds and deeply freezes a Profile Snapshot with public boundaries', () => {
  const snapshot = buildAgentContextSnapshot({
    profileVersion: 4,
    profileConfirmedAt: '2026-09-14T00:00:00.000Z',
    impressions: ['第一段有效的公开人物印象。', '第二段有效的私人人物印象。', '第三段有效的公开人物印象。'],
    profileSourceReferences: [['source-1'], ['source-2'], ['source-3']],
    profilePublicBoundaries: ['public', 'private', 'public']
  }, ' owner-1 ');
  assert.equal(snapshot.ownerId, 'owner-1');
  assert.equal(snapshot.profileVersion, 4);
  assert.equal(snapshot.confirmedAt, '2026-09-14T00:00:00.000Z');
  assert.deepEqual(snapshot.sections.map(section => section.dimension), ['thinking', 'interests', 'connection']);
  assert.equal(snapshot.sections[1].publicBoundary, 'private');
  assert.deepEqual(snapshot.sections[1].sourceReferences, ['source-2']);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.sections), true);
  assert.equal(Object.isFrozen(snapshot.sections[0].sourceReferences), true);
});

test('defaults omitted Profile boundaries to private', () => {
  const snapshot = buildAgentContextSnapshot({
    impressions: ['第一段有效的人物印象内容。', '第二段有效的人物印象内容。', '第三段有效的人物印象内容。']
  }, 'owner-1');
  assert.deepEqual(snapshot.sections.map(section => section.publicBoundary), ['private', 'private', 'private']);
});

test('rejects malformed Profile Snapshot input', () => {
  assert.throws(() => buildAgentContextSnapshot({ impressions: ['只有一段'] }, 'user-1'), /PROFILE_REQUIRES_THREE_IMPRESSIONS/);
  assert.throws(() => buildAgentContextSnapshot({ impressions: ['内容长度足够一二三', '内容长度足够一二三', '内容长度足够一二三'], profilePublicBoundaries: ['public', 'secret', 'public'] }, 'user-1'), /PROFILE_PUBLIC_BOUNDARY_2_INVALID/);
  assert.throws(() => buildAgentContextSnapshot({ impressions: ['内容长度足够一二三', '内容长度足够一二三', '内容长度足够一二三'], profileConfirmedAt: 'not-a-date' }, 'user-1'), /PROFILE_CONFIRMED_AT_INVALID/);
});

test('rejects an invalid TriggerEvent', () => {
  assert.deepEqual(routeTrigger({ type: 'explore.requested' }, context), { accepted: false, code: 'INVALID_EVENT' });
  assert.equal(isTriggerEvent({ ...event('explore.requested', { target: 'people' }), occurredAt: 'not-a-date' }), false);
  assert.equal(isTriggerEvent({ ...event('explore.requested', { target: 'people' }), actor: { userId: 'user-1', sessionId: 1 } }), false);
  assert.equal(isTriggerEvent({ ...event('explore.requested', { target: 'people' }), subject: { kind: 'run', id: '', version: 0 } }), false);
  assert.equal(isTriggerEvent({ ...event('explore.requested', { target: 'people' }), idempotencyKey: 1 }), false);
});

test('routes skill_run.requested to the existing runner destination', () => {
  assert.deepEqual(routeTrigger(event('skill_run.requested', { skillId: 'people-skill' }), context), {
    accepted: true,
    destination: 'skill-runner',
    command: 'start-or-reuse-run',
    skillId: 'people-skill',
    profileVersion: 1,
    correlationId: 'correlation-1'
  });
});

test('routes people Explore requests', () => {
  const plan = routeTrigger(event('explore.requested', { target: 'people' }), context);
  assert.equal(plan.accepted && plan.destination, 'explore');
  assert.equal(plan.accepted && plan.destination === 'explore' && plan.target, 'people');
});

test('routes content Explore requests', () => {
  const plan = routeTrigger(event('explore.requested', { target: 'content' }), context);
  assert.equal(plan.accepted && plan.destination, 'explore');
  assert.equal(plan.accepted && plan.destination === 'explore' && plan.target, 'content');
});

test('rejects actor mismatch, disabled Skills and invalid Explore targets', () => {
  assert.deepEqual(routeTrigger(event('explore.requested', { target: 'people' }), { ...context, actorId: 'another-user' }), { accepted: false, code: 'ACTOR_MISMATCH' });
  assert.deepEqual(routeTrigger(event('skill_run.requested', { skillId: 'people-skill' }), { ...context, skills: [{ id: 'people-skill', enabled: false }] }), { accepted: false, code: 'SKILL_DISABLED' });
  assert.deepEqual(routeTrigger(event('explore.requested', { target: 'accounts' }), context), { accepted: false, code: 'INVALID_EVENT' });
});

test('rejects triggers when the profile is not confirmed', () => {
  assert.deepEqual(routeTrigger(event('explore.requested', { target: 'people' }), { ...context, profile: null }), {
    accepted: false,
    code: 'PROFILE_NOT_CONFIRMED'
  });
  const unconfirmed = buildAgentContextSnapshot({
    impressions: ['第一段有效的人物印象内容。', '第二段有效的人物印象内容。', '第三段有效的人物印象内容。'],
    profilePublicBoundaries: ['public', 'public', 'public']
  }, 'user-1');
  assert.deepEqual(routeTrigger(event('explore.requested', { target: 'people' }), { ...context, profile: unconfirmed }), {
    accepted: false,
    code: 'PROFILE_NOT_CONFIRMED'
  });
});

test('rejects a missing Skill', () => {
  assert.deepEqual(routeTrigger(event('skill_run.requested', { skillId: 'missing' }), context), {
    accepted: false,
    code: 'SKILL_NOT_FOUND'
  });
});

test('returns an empty Explore result instead of inventing a candidate', () => {
  const result = recallPeople([{ id: 'person-1', name: '甲', role: '设计师', bio: '关注交互', tags: ['设计'] }], '量子农业', profile);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.recommendations, []);
});

test('returns structured People and Content recommendations with evidence', () => {
  const people = recallPeople([{ id: 'person-1', name: '甲', role: 'AI 产品经理', bio: '关注产品入口', tags: ['AI 产品'] }], 'AI 产品', profile);
  assert.equal(people.candidates[0].id, 'person-1');
  assert.ok(people.recommendations[0].reason);
  assert.equal(people.recommendations[0].evidenceRefs[0].sourceType, 'profile');
  assert.equal(people.recommendations[0].evidenceRefs[1].sourceType, 'candidate');
  assert.equal(typeof people.recommendations[0].metrics.topicRelevance, 'number');
  assert.equal(typeof people.recommendations[0].metrics.informationGain, 'number');
  assert.equal(typeof people.recommendations[0].metrics.explorableDivergence, 'number');
  assert.ok(people.recommendations[0].metrics.evidenceStrength >= 0.6);
  assert.ok(people.recommendations[0].metrics.evidenceStrength < 1);
  assert.ok(['recommended', 'consider', 'not_recommended'].includes(people.recommendations[0].verdict));
  assert.equal(typeof people.recommendations[0].a2aEligible, 'boolean');
  assert.ok(people.recommendations[0].a2aReasons.length > 0);

  const content = recallContent([{ id: 'content-1', title: 'AI 产品入口复盘', excerpt: '比较聊天和任务入口', tags: ['AI 产品'] }], 'AI 产品', profile);
  assert.equal(content.candidates[0].id, 'content-1');
  assert.ok(content.recommendations[0].reason);
  assert.deepEqual(content.recommendations[0].evidenceRefs.map(item => item.sourceType), ['profile', 'content']);
  assert.equal(content.recommendations[0].a2aEligible, false);
  assert.deepEqual(content.recommendations[0].a2aReasons, ['A2A_REQUIRES_PERSON']);
});

test('never exposes private Profile sections as recommendation evidence', () => {
  const privateProfile = buildAgentContextSnapshot({
    impressions: ['这是一段公开的产品观察。', '这是一段包含量子农业的私密信息。', '这是一段公开的交流偏好。'],
    profilePublicBoundaries: ['public', 'private', 'public']
  }, 'user-1');
  const result = recallPeople([{ id: 'person-1', name: '甲', role: '研究员', bio: '研究量子农业', tags: ['量子农业'] }], '量子农业', privateProfile);
  assert.equal(result.recommendations[0].evidenceRefs[0].excerpt?.includes('私密信息'), false);

  const fullyPrivate = buildAgentContextSnapshot({
    impressions: ['这是一段有效的私密内容。', '这是另一段有效的私密内容。', '这是第三段有效的私密内容。'],
    profilePublicBoundaries: ['private', 'private', 'private']
  }, 'user-1');
  assert.deepEqual(recallPeople([{ id: 'person-1', name: '甲', role: '研究员', bio: '研究量子农业', tags: ['量子农业'] }], '量子农业', fullyPrivate).candidates, []);
});

test('does not use an unrelated public Profile section as evidence', () => {
  const unrelatedProfile = buildAgentContextSnapshot({
    impressions: ['这是一段公开的烘焙经验总结。', '这是一段有效的私密兴趣信息。', '这是一段有效的私密交流偏好。'],
    profilePublicBoundaries: ['public', 'private', 'private']
  }, 'user-1');
  const result = recallPeople([{ id: 'person-1', name: '甲', role: '研究员', bio: '研究量子农业', tags: ['量子农业'] }], '量子农业', unrelatedProfile);
  assert.deepEqual(result.recommendations[0].evidenceRefs.map(item => item.sourceType), ['candidate']);
});

test('keeps the A2A adapter independent and opt-in', async () => {
  const adapter: A2AAdapter = {
    async evaluate(request: A2AEvaluationRequest) {
      return { eligible: request.evidenceRefIds.length > 0, reasons: ['TEST_ONLY'] };
    }
  };
  const result = await adapter.evaluate({ requesterId: 'user-1', candidateId: 'person-1', profileVersion: 1, topic: 'AI 产品入口', recommendationId: 'recommendation-1', evidenceRefIds: ['profile:1:thinking'] });
  assert.deepEqual(result, { eligible: true, reasons: ['TEST_ONLY'] });
});
