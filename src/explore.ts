import type { AgentContextSnapshot } from './agent-context.ts';

export type PeopleCandidate = Readonly<{
  id: string;
  name: string;
  role: string;
  bio: string;
  tags: readonly string[];
  topic?: string;
}>;

export type ContentCandidate = Readonly<{
  id: string;
  title: string;
  excerpt: string;
  tags: readonly string[];
  authorId?: string;
}>;

export type MatchMetrics = Readonly<{
  topicRelevance: number;
  informationGain: number;
  explorableDivergence: number;
  evidenceStrength: number;
}>;

export type MatchVerdict = 'recommended' | 'consider' | 'not_recommended';

export type EvidenceRef = Readonly<{
  sourceType: 'profile' | 'skill' | 'candidate' | 'content';
  sourceId: string;
  excerpt?: string;
  sourceReferences?: readonly string[];
}>;

export type Recommendation = Readonly<{
  id: string;
  targetType: 'person' | 'content';
  targetId: string;
  metrics: MatchMetrics;
  verdict: MatchVerdict;
  reason: string;
  evidenceRefs: readonly EvidenceRef[];
  a2aEligible: boolean;
  a2aReasons: readonly string[];
}>;

export type ExploreResult<T extends PeopleCandidate | ContentCandidate> = Readonly<{
  target: 'people' | 'content';
  candidates: readonly T[];
  recommendations: readonly Recommendation[];
}>;

function terms(query: string) {
  return [...new Set(query.toLowerCase().split(/[\s,，、]+/).map(item => item.trim()).filter(Boolean))];
}

function matches(queryTerms: readonly string[], text: string) {
  const haystack = text.toLowerCase();
  return queryTerms.some(term => haystack.includes(term));
}

function evidence(profile: AgentContextSnapshot, queryTerms: readonly string[]) {
  const publicSections = profile.sections.filter(item => item.publicBoundary === 'public');
  const section = publicSections.find(item => matches(queryTerms, item.impression)) || publicSections[0];
  return Object.freeze(section ? [{ sourceType: 'profile' as const, sourceId: `profile:${profile.profileVersion}:${section.dimension}`, excerpt: section.impression.slice(0, 80), sourceReferences: section.sourceReferences }] : []);
}

function rounded(value: number) {
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

function metrics(queryTerms: readonly string[], candidateText: string, tags: readonly string[], topic: string, profile: AgentContextSnapshot, evidenceRefs: readonly EvidenceRef[]): MatchMetrics {
  const matchedTerms = queryTerms.filter(term => candidateText.toLowerCase().includes(term));
  const publicProfile = profile.sections.filter(section => section.publicBoundary === 'public').map(section => section.impression).join(' ').toLowerCase();
  const novelTags = tags.filter(tag => !publicProfile.includes(tag.toLowerCase()));
  const asksForDivergence = /不同|分歧|碰撞|取舍|争议|反对/.test(queryTerms.join(' '));
  const topicCanDiverge = /还是|应该|取舍|不同|[?？]/.test(topic);
  return Object.freeze({
    topicRelevance: rounded(matchedTerms.length / Math.max(1, Math.min(queryTerms.length, 4))),
    informationGain: rounded(novelTags.length / Math.max(1, tags.length)),
    explorableDivergence: rounded(topicCanDiverge ? (asksForDivergence ? 0.9 : 0.65) : 0.2),
    evidenceStrength: rounded(evidenceRefs.length / 2)
  });
}

function recommendation(targetType: 'person' | 'content', targetId: string, queryTerms: readonly string[], candidateText: string, tags: readonly string[], topic: string, profile: AgentContextSnapshot, evidenceRefs: readonly EvidenceRef[]): Recommendation {
  const matchMetrics = metrics(queryTerms, candidateText, tags, topic, profile, evidenceRefs);
  const score = matchMetrics.topicRelevance * 0.35 + matchMetrics.informationGain * 0.25 + matchMetrics.explorableDivergence * 0.2 + matchMetrics.evidenceStrength * 0.2;
  const verdict: MatchVerdict = score >= 0.6 ? 'recommended' : score >= 0.4 ? 'consider' : 'not_recommended';
  const a2aEligible = targetType === 'person' && verdict === 'recommended' && matchMetrics.explorableDivergence >= 0.5 && matchMetrics.evidenceStrength >= 0.75;
  const a2aReasons = targetType !== 'person'
    ? ['A2A_REQUIRES_PERSON']
    : a2aEligible
      ? ['RECOMMENDED_MATCH', 'EXPLORABLE_TOPIC', 'SUFFICIENT_EVIDENCE']
      : [verdict !== 'recommended' ? 'MATCH_NOT_STRONG_ENOUGH' : '', matchMetrics.explorableDivergence < 0.5 ? 'LIMITED_DIVERGENCE' : '', matchMetrics.evidenceStrength < 0.75 ? 'INSUFFICIENT_EVIDENCE' : ''].filter(Boolean);
  return Object.freeze({
    id: `recommendation:${profile.profileVersion}:${targetType}:${targetId}`,
    targetType,
    targetId,
    metrics: matchMetrics,
    verdict,
    reason: verdict === 'recommended' ? '候选与当前议题高度相关，并能带来有证据的新信息或可展开讨论。' : verdict === 'consider' ? '候选与当前议题相关，但信息增量或可展开分歧仍需进一步确认。' : '当前证据不足以支持优先推荐。',
    evidenceRefs: Object.freeze([...evidenceRefs]),
    a2aEligible,
    a2aReasons: Object.freeze(a2aReasons)
  });
}

export function recallPeople(candidates: readonly PeopleCandidate[], query: string, profile: AgentContextSnapshot, limit = 10): ExploreResult<PeopleCandidate> {
  const queryTerms = terms(query);
  if (!queryTerms.length || !profile.sections.some(section => section.publicBoundary === 'public')) return Object.freeze({ target: 'people', candidates: Object.freeze([]), recommendations: Object.freeze([]) });
  const found = candidates.filter(candidate => matches(queryTerms, `${candidate.name} ${candidate.role} ${candidate.bio} ${candidate.tags.join(' ')}`)).slice(0, limit);
  return Object.freeze({
    target: 'people',
    candidates: Object.freeze([...found]),
    recommendations: Object.freeze(found.map(candidate => {
      const profileEvidence = evidence(profile, queryTerms);
      const candidateEvidence = Object.freeze({ sourceType: 'candidate' as const, sourceId: candidate.id, excerpt: `${candidate.role}；${candidate.bio}`.slice(0, 80) });
      return recommendation('person', candidate.id, queryTerms, `${candidate.name} ${candidate.role} ${candidate.bio} ${candidate.tags.join(' ')}`, candidate.tags, candidate.topic || '', profile, [...profileEvidence, candidateEvidence]);
    }))
  });
}

export function recallContent(candidates: readonly ContentCandidate[], query: string, profile: AgentContextSnapshot, limit = 10): ExploreResult<ContentCandidate> {
  const queryTerms = terms(query);
  if (!queryTerms.length || !profile.sections.some(section => section.publicBoundary === 'public')) return Object.freeze({ target: 'content', candidates: Object.freeze([]), recommendations: Object.freeze([]) });
  const found = candidates.filter(candidate => matches(queryTerms, `${candidate.title} ${candidate.excerpt} ${candidate.tags.join(' ')}`)).slice(0, limit);
  return Object.freeze({
    target: 'content',
    candidates: Object.freeze([...found]),
    recommendations: Object.freeze(found.map(candidate => {
      const contentEvidence = Object.freeze({ sourceType: 'content' as const, sourceId: candidate.id, excerpt: candidate.excerpt.slice(0, 80) });
      return recommendation('content', candidate.id, queryTerms, `${candidate.title} ${candidate.excerpt} ${candidate.tags.join(' ')}`, candidate.tags, candidate.title, profile, [...evidence(profile, queryTerms), contentEvidence]);
    }))
  });
}
