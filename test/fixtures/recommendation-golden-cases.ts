import { buildAgentContextSnapshot } from '../../src/agent-context.ts';
import type { MatchInput, MatchVerdict } from '../../src/match-engine.ts';

const publicProfile = buildAgentContextSnapshot({
  profileVersion: 7,
  impressions: [
    '我正在研究 AI 产品入口，并关注聊天与任务流程的取舍。',
    '我已经完成基础用户访谈，希望获得新的实际案例。',
    '我愿意围绕可靠证据讨论不同观点。'
  ],
  profileSourceReferences: [['profile-source-1'], ['profile-source-2'], ['profile-source-3']],
  profilePublicBoundaries: ['public', 'public', 'public']
}, 'golden-user');

const privateProfile = buildAgentContextSnapshot({
  profileVersion: 8,
  impressions: ['这是一段有效的私密思考。', '这是一段有效的私密兴趣。', '这是一段有效的私密交流偏好。'],
  profilePublicBoundaries: ['private', 'private', 'private']
}, 'private-user');

const strongEvidence = [
  { sourceType: 'profile' as const, sourceId: 'profile:7:thinking', excerpt: publicProfile.sections[0].impression, sourceReferences: ['profile-source-1'], quality: 'primary' as const },
  { sourceType: 'candidate' as const, sourceId: 'candidate-1', excerpt: '候选人完成过两次真实入口改版。', quality: 'primary' as const }
];

type GoldenCase = Readonly<{
  name: string;
  input: MatchInput;
  expectedVerdict: MatchVerdict;
  expectedA2AEligible: boolean;
}>;

export const recommendationGoldenCases: readonly GoldenCase[] = [
  {
    name: '高相关且高信息增量',
    input: { targetType: 'person', query: 'AI 产品', profile: publicProfile, candidate: { id: 'candidate-high-gain', searchableText: 'AI 产品入口真实改版', topics: ['AI', '产品'], informationSignals: ['完成过两次入口改版', '观察过任务入口上线数据'], divergenceSignals: [] }, evidenceRefs: strongEvidence },
    expectedVerdict: 'recommended', expectedA2AEligible: true
  },
  {
    name: '高相关但没有新增信息',
    input: { targetType: 'person', query: 'AI 产品', profile: publicProfile, candidate: { id: 'candidate-no-gain', searchableText: 'AI 产品入口', topics: ['AI', '产品'], informationSignals: ['AI 产品入口'], divergenceSignals: [] }, evidenceRefs: strongEvidence },
    expectedVerdict: 'consider', expectedA2AEligible: false
  },
  {
    name: '存在明显且可展开的分歧',
    input: { targetType: 'person', query: 'AI 产品 入口 取舍', profile: publicProfile, candidate: { id: 'candidate-divergence', searchableText: 'AI 产品聊天入口与任务入口取舍', topics: ['AI', '产品', '入口', '取舍'], informationSignals: [], divergenceSignals: ['用户偏向任务入口，候选人主张聊天入口', '双方都有真实测试依据'] }, evidenceRefs: strongEvidence },
    expectedVerdict: 'recommended', expectedA2AEligible: true
  },
  {
    name: '主题相关但证据不足',
    input: { targetType: 'person', query: 'AI 产品', profile: publicProfile, candidate: { id: 'candidate-weak-evidence', searchableText: 'AI 产品入口', topics: ['AI', '产品'], informationSignals: ['自称做过一次改版'], divergenceSignals: [] }, evidenceRefs: [{ sourceType: 'candidate', sourceId: 'candidate-weak-evidence', excerpt: '做过改版', quality: 'self_reported' }] },
    expectedVerdict: 'consider', expectedA2AEligible: false
  },
  {
    name: '全私有 Profile',
    input: { targetType: 'person', query: 'AI 产品', profile: privateProfile, candidate: { id: 'candidate-private', searchableText: 'AI 产品入口', topics: ['AI', '产品'], informationSignals: ['新的改版经验'], divergenceSignals: [] }, evidenceRefs: strongEvidence },
    expectedVerdict: 'not_recommended', expectedA2AEligible: false
  },
  {
    name: 'Content 不进入 A2A',
    input: { targetType: 'content', query: 'AI 产品', profile: publicProfile, candidate: { id: 'content-1', searchableText: 'AI 产品入口数据复盘', topics: ['AI', '产品'], informationSignals: ['包含两组入口实验数据', '记录改版前后转化变化'], divergenceSignals: [] }, evidenceRefs: [{ ...strongEvidence[0] }, { sourceType: 'content', sourceId: 'content-1', excerpt: '两组入口实验数据', quality: 'primary' }] },
    expectedVerdict: 'recommended', expectedA2AEligible: false
  }
];
