import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentContextSnapshot } from '../src/agent-context.ts';
import { extractSkillDiscoveryIntent } from '../src/skill-discovery-bridge.ts';

const profile = buildAgentContextSnapshot({
  profileVersion: 2,
  profileConfirmedAt: '2026-09-14T00:00:00.000Z',
  impressions: [
    '我关注 AI 产品入口与任务流程的真实取舍。',
    '我会亲自验证交互方案，也愿意分享用户访谈实践。',
    '我想认识愿意围绕证据认真交流的人。'
  ],
  profilePublicBoundaries: ['public', 'private', 'public']
}, 'owner-1');

test('builds the people discovery intent from Skill content without profile context', () => {
  const intent = extractSkillDiscoveryIntent({
    id: 'run-1',
    status: 'completed',
    profileSnapshot: profile,
    skill: { name: '观点碰撞', kind: 'people', goal: '寻找不同观点的人', keywords: '产品 设计' }
  });

  assert.ok(intent);
  assert.equal(intent.query, '寻找不同观点的人 产品 设计');
  assert.doesNotMatch(intent.query, /AI 产品入口与任务流程/);
  assert.doesNotMatch(intent.query, /亲自验证交互方案/);
  assert.deepEqual(intent.constraints.keywords, ['产品', '设计']);
});

test('falls back to skill clues when no profile snapshot is available', () => {
  const intent = extractSkillDiscoveryIntent({
    id: 'run-2',
    status: 'completed',
    skill: { name: '项目搭子', goal: '寻找开发者', keywords: '开发 独立' }
  });

  assert.equal(intent?.query, '寻找开发者 开发 独立');
});
