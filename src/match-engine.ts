import type { AgentContextSnapshot } from './agent-context.ts';

export type MatchTargetType = 'person' | 'content';
export type MatchVerdict = 'recommended' | 'consider' | 'not_recommended';
export type EvidenceQuality = 'primary' | 'secondary' | 'self_reported';

export type EvidenceRef = Readonly<{
  sourceType: 'profile' | 'skill' | 'candidate' | 'content';
  sourceId: string;
  excerpt?: string;
  sourceReferences?: readonly string[];
  quality?: EvidenceQuality;
}>;

export type MatchInput = Readonly<{
  targetType: MatchTargetType;
  query: string;
  profile: AgentContextSnapshot;
  candidate: Readonly<{
    id: string;
    searchableText: string;
    topics: readonly string[];
    informationSignals: readonly string[];
    divergenceSignals: readonly string[];
  }>;
  evidenceRefs: readonly EvidenceRef[];
}>;

export type MatchMetrics = Readonly<{
  topicRelevance: number;
  informationGain: number;
  explorableDivergence: number;
  evidenceStrength: number;
}>;

export type MatchReasonCode =
  | 'NO_PUBLIC_PROFILE'
  | 'LOW_TOPIC_RELEVANCE'
  | 'HIGH_TOPIC_RELEVANCE'
  | 'NO_NEW_INFORMATION'
  | 'NEW_INFORMATION'
  | 'EXPLORABLE_DIVERGENCE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'SUFFICIENT_EVIDENCE';

export type MatchAssessment = Readonly<{
  metrics: MatchMetrics;
  verdict: MatchVerdict;
  reason: string;
  reasonCodes: readonly MatchReasonCode[];
  a2aEligible: boolean;
  a2aReasons: readonly string[];
}>;

function terms(value: string) {
  return [...new Set(value.toLowerCase().split(/[\s,，、。；;：:!?！？]+/).map(item => item.trim()).filter(Boolean))];
}

function rounded(value: number) {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function includes(text: string, term: string) {
  return text.toLowerCase().includes(term);
}

function topicRelevance(input: MatchInput) {
  const queryTerms = terms(input.query);
  if (!queryTerms.length) return 0;
  const topicText = input.candidate.topics.join(' ').toLowerCase();
  const searchableText = input.candidate.searchableText.toLowerCase();
  const denominator = Math.max(1, Math.min(queryTerms.length, 4));
  const topicMatches = queryTerms.filter(term => topicText.includes(term)).length;
  const bodyMatches = queryTerms.filter(term => searchableText.includes(term)).length;
  return rounded((topicMatches * 0.7 + bodyMatches * 0.3) / denominator);
}

function evidenceStrength(evidenceRefs: readonly EvidenceRef[]) {
  const weights: Record<EvidenceQuality, number> = { primary: 1, secondary: 0.75, self_reported: 0.5 };
  const unique = [...new Map(evidenceRefs.map(ref => [`${ref.sourceType}:${ref.sourceId}`, ref])).values()];
  const total = unique.reduce((sum, ref) => {
    const quality = ref.quality || (ref.sourceReferences?.length ? 'primary' : 'self_reported');
    const usable = ref.excerpt?.trim() || ref.sourceReferences?.some(source => source.trim());
    return sum + (usable ? weights[quality] : 0);
  }, 0);
  return rounded(total / 2);
}

function informationGain(input: MatchInput, evidence: number) {
  const publicProfile = input.profile.sections.filter(section => section.publicBoundary === 'public').map(section => section.impression).join(' ').toLowerCase();
  const novel = [...new Set(input.candidate.informationSignals.map(signal => signal.trim()).filter(signal => signal && !includes(publicProfile, signal.toLowerCase())))];
  const hasCandidateEvidence = input.evidenceRefs.some(ref => ref.sourceType === 'candidate' || ref.sourceType === 'content');
  if (!hasCandidateEvidence) return 0;
  return rounded(Math.min(1, novel.length / 2) * Math.min(1, evidence / 0.6));
}

function explorableDivergence(input: MatchInput, evidence: number) {
  const signals = [...new Set(input.candidate.divergenceSignals.map(signal => signal.trim()).filter(Boolean))];
  if (!signals.length) return 0;
  return rounded(Math.min(1, signals.length / 2) * Math.min(1, evidence / 0.6));
}

function reasonFor(metrics: MatchMetrics, verdict: MatchVerdict) {
  const clauses: string[] = [];
  clauses.push(metrics.topicRelevance >= 0.65 ? '候选与当前议题高度相关' : metrics.topicRelevance >= 0.25 ? '候选与当前议题有一定相关性' : '候选与当前议题相关性较低');
  if (metrics.informationGain >= 0.55) clauses.push('能够提供已确认画像之外的新信息');
  else clauses.push('目前可见信息与已有画像重复较多');
  if (metrics.explorableDivergence >= 0.55) clauses.push('存在有依据且可以继续展开的分歧');
  if (metrics.evidenceStrength < 0.6) clauses.push('但现有证据仍不足');
  const conclusion = verdict === 'recommended' ? '建议优先了解。' : verdict === 'consider' ? '建议补充证据后再决定。' : '暂不建议优先推荐。';
  return `${clauses.join('；')}，${conclusion}`;
}

export function assessMatch(input: MatchInput): MatchAssessment {
  const hasPublicProfile = input.profile.sections.some(section => section.publicBoundary === 'public');
  if (!hasPublicProfile) return Object.freeze({ metrics: Object.freeze({ topicRelevance: 0, informationGain: 0, explorableDivergence: 0, evidenceStrength: 0 }), verdict: 'not_recommended', reason: 'Profile 没有允许用于匹配的公开内容，暂不生成推荐。', reasonCodes: Object.freeze(['NO_PUBLIC_PROFILE']), a2aEligible: false, a2aReasons: Object.freeze(['NO_PUBLIC_PROFILE']) });

  const evidence = evidenceStrength(input.evidenceRefs);
  const metrics = Object.freeze({
    topicRelevance: topicRelevance(input),
    informationGain: informationGain(input, evidence),
    explorableDivergence: explorableDivergence(input, evidence),
    evidenceStrength: evidence
  });

  let verdict: MatchVerdict;
  if (metrics.topicRelevance < 0.25 || metrics.evidenceStrength < 0.25) verdict = 'not_recommended';
  else if (metrics.evidenceStrength >= 0.6 && metrics.topicRelevance >= 0.65 && (metrics.informationGain >= 0.55 || metrics.explorableDivergence >= 0.55)) verdict = 'recommended';
  else if (metrics.topicRelevance >= 0.25 && metrics.evidenceStrength >= 0.25) verdict = 'consider';
  else verdict = 'not_recommended';

  const reasonCodes: MatchReasonCode[] = [
    metrics.topicRelevance >= 0.65 ? 'HIGH_TOPIC_RELEVANCE' : 'LOW_TOPIC_RELEVANCE',
    metrics.informationGain >= 0.55 ? 'NEW_INFORMATION' : 'NO_NEW_INFORMATION',
    ...(metrics.explorableDivergence >= 0.55 ? ['EXPLORABLE_DIVERGENCE' as const] : []),
    metrics.evidenceStrength >= 0.6 ? 'SUFFICIENT_EVIDENCE' : 'INSUFFICIENT_EVIDENCE'
  ];
  const hasCandidateEvidence = input.evidenceRefs.some(ref => ref.sourceType === 'candidate');
  const a2aEligible = input.targetType === 'person' && verdict === 'recommended' && metrics.evidenceStrength >= 0.7 && (metrics.informationGain >= 0.55 || metrics.explorableDivergence >= 0.55) && hasCandidateEvidence;
  const a2aReasons = input.targetType !== 'person'
    ? ['A2A_REQUIRES_PERSON']
    : a2aEligible
      ? ['RECOMMENDED_MATCH', 'VALUABLE_EXCHANGE', 'SUFFICIENT_EVIDENCE']
      : [verdict !== 'recommended' ? 'MATCH_NOT_STRONG_ENOUGH' : '', metrics.informationGain < 0.55 && metrics.explorableDivergence < 0.55 ? 'LIMITED_EXCHANGE_VALUE' : '', metrics.evidenceStrength < 0.7 || !hasCandidateEvidence ? 'INSUFFICIENT_EVIDENCE' : ''].filter(Boolean);

  return Object.freeze({ metrics, verdict, reason: reasonFor(metrics, verdict), reasonCodes: Object.freeze(reasonCodes), a2aEligible, a2aReasons: Object.freeze(a2aReasons) });
}
