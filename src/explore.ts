import type { AgentContextSnapshot } from './agent-context.ts';
import { assessMatch, type EvidenceRef, type MatchMetrics, type MatchReasonCode, type MatchVerdict } from './match-engine.ts';

export type { EvidenceRef, MatchMetrics, MatchReasonCode, MatchVerdict } from './match-engine.ts';

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

export type Recommendation = Readonly<{
  id: string;
  targetType: 'person' | 'content';
  targetId: string;
  metrics: MatchMetrics;
  verdict: MatchVerdict;
  reason: string;
  reasonCodes: readonly MatchReasonCode[];
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
  const section = publicSections.find(item => matches(queryTerms, item.impression));
  return Object.freeze(section ? [{ sourceType: 'profile' as const, sourceId: `profile:${profile.profileVersion}:${section.dimension}`, excerpt: section.impression.slice(0, 80), sourceReferences: section.sourceReferences }] : []);
}

function recommendation(targetType: 'person' | 'content', targetId: string, query: string, searchableText: string, topics: readonly string[], informationSignals: readonly string[], divergenceSignals: readonly string[], profile: AgentContextSnapshot, evidenceRefs: readonly EvidenceRef[]): Recommendation {
  const assessment = assessMatch({ targetType, query, profile, candidate: { id: targetId, searchableText, topics, informationSignals, divergenceSignals }, evidenceRefs });
  return Object.freeze({ id: `recommendation:${profile.profileVersion}:${targetType}:${targetId}`, targetType, targetId, ...assessment, evidenceRefs: Object.freeze([...evidenceRefs]) });
}

export function recallPeople(candidates: readonly PeopleCandidate[], query: string, profile: AgentContextSnapshot, limit = 10): ExploreResult<PeopleCandidate> {
  const queryTerms = terms(query);
  if (!queryTerms.length || !profile.sections.some(section => section.publicBoundary === 'public')) return Object.freeze({ target: 'people', candidates: Object.freeze([]), recommendations: Object.freeze([]) });
  const found = candidates.filter(candidate => matches(queryTerms, `${candidate.name} ${candidate.role} ${candidate.bio} ${candidate.tags.join(' ')} ${candidate.topic || ''}`)).slice(0, limit);
  return Object.freeze({
    target: 'people',
    candidates: Object.freeze([...found]),
    recommendations: Object.freeze(found.map(candidate => {
      const profileEvidence = evidence(profile, queryTerms);
      const candidateEvidence = Object.freeze({ sourceType: 'candidate' as const, sourceId: candidate.id, excerpt: `${candidate.role}；${candidate.bio}`.slice(0, 80), quality: 'self_reported' as const });
      const divergenceSignals = /不同|分歧|碰撞|取舍|争议|反对/.test(query) && /还是|取舍|不同/.test(candidate.topic || '') ? [candidate.topic || ''] : [];
      return recommendation('person', candidate.id, query, `${candidate.name} ${candidate.role} ${candidate.bio} ${candidate.tags.join(' ')} ${candidate.topic || ''}`, candidate.tags, [candidate.role, candidate.bio], divergenceSignals, profile, [...profileEvidence, candidateEvidence]);
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
      const contentEvidence = Object.freeze({ sourceType: 'content' as const, sourceId: candidate.id, excerpt: candidate.excerpt.slice(0, 80), quality: 'primary' as const });
      return recommendation('content', candidate.id, query, `${candidate.title} ${candidate.excerpt} ${candidate.tags.join(' ')}`, candidate.tags, [candidate.excerpt], [], profile, [...evidence(profile, queryTerms), contentEvidence]);
    }))
  });
}
