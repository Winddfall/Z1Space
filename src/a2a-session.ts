import { randomUUID } from 'node:crypto';
import type { A2ASessionAdapter, F05InvitationDraftPort } from './a2a-adapter.ts';
import type { AgentContextSnapshot } from './agent-context.ts';
import type { EvidenceQuality, EvidenceRef, MatchVerdict } from './match-engine.ts';

export type RecommendationSnapshot = Readonly<{
  recommendationId: string;
  ownerId: string;
  candidateId: string;
  targetType: 'person' | 'content';
  query: string;
  profileVersion: number;
  verdict: MatchVerdict;
  a2aEligible: boolean;
  a2aReasons: readonly string[];
  evidenceRefs: readonly EvidenceRef[];
  createdAt: string;
}>;

export type A2AEvidence = Readonly<{
  id: string;
  owner: 'requester' | 'candidate';
  sourceType: EvidenceRef['sourceType'] | 'candidate_profile';
  excerpt: string;
  quality: EvidenceQuality;
  sourceReferences: readonly string[];
}>;

export type A2AEvidenceLedger = Readonly<{ entries: readonly A2AEvidence[] }>;

export type A2AClaim = Readonly<{ text: string; evidenceRefIds: readonly string[] }>;
export type A2ATurnIntent = 'position' | 'question' | 'response' | 'summary';
export type A2ATurn = Readonly<{
  id: string;
  round: 1 | 2 | 3;
  speaker: 'requester_agent' | 'candidate_agent';
  intent: A2ATurnIntent;
  text: string;
  claims: readonly A2AClaim[];
  questions: readonly string[];
  createdAt: string;
}>;

export type A2AObserverVerdict = 'proceed' | 'needs_user_review' | 'stop';
export type A2AObserverReasonCode = 'MUTUAL_TOPIC_ALIGNMENT' | 'COMPLEMENTARY_EXPERIENCE' | 'EXPLORABLE_DIVERGENCE' | 'ACTIONABLE_NEXT_QUESTION' | 'ONE_SIDED_EVIDENCE' | 'INSUFFICIENT_EVIDENCE' | 'CONTRADICTORY_EVIDENCE' | 'NO_CLEAR_EXCHANGE_VALUE';
export type A2AObservation = Readonly<{
  verdict: A2AObserverVerdict;
  reason: string;
  reasonCodes: readonly A2AObserverReasonCode[];
  evidenceRefs: readonly string[];
  suggestedTopic?: string;
  suggestedOpening?: string;
}>;

export type F05HandoffPayload = Readonly<{
  source: 'a2a_session';
  sourceSessionId: string;
  recommendationId: string;
  senderId: string;
  recipientId: string;
  topic: string;
  suggestedOpening: string;
  observerVerdict: Exclude<A2AObserverVerdict, 'stop'>;
  reason: string;
  evidenceRefIds: readonly string[];
}>;

export type A2ASessionStatus = 'created' | 'running' | 'observing' | 'completed' | 'failed';
export type A2ASession = Readonly<{
  id: string;
  requesterId: string;
  candidateId: string;
  recommendationId: string;
  topic: string;
  status: A2ASessionStatus;
  currentRound: 0 | 1 | 2 | 3;
  requesterProfileVersion: number;
  candidateProfileVersion: number;
  evidenceLedger: A2AEvidenceLedger;
  turns: readonly A2ATurn[];
  observation?: A2AObservation;
  f05Handoff?: F05HandoffPayload;
  f05DraftId?: string;
  failureCode?: string;
  createdAt: string;
  completedAt?: string;
}>;

export type A2ATurnRequest = Readonly<{ round: 1 | 2 | 3; speaker: A2ATurn['speaker']; topic: string; evidenceLedger: A2AEvidenceLedger; previousTurns: readonly A2ATurn[] }>;
export type A2ATurnDraft = Readonly<{ intent: A2ATurnIntent; text: string; claims: readonly A2AClaim[]; questions: readonly string[] }>;
export type A2AObserverRequest = Readonly<{ topic: string; evidenceLedger: A2AEvidenceLedger; turns: readonly A2ATurn[] }>;
export type A2AObservationDraft = A2AObservation;

const TURN_INTENTS = new Set<A2ATurnIntent>(['position', 'question', 'response', 'summary']);
const OBSERVER_VERDICTS = new Set<A2AObserverVerdict>(['proceed', 'needs_user_review', 'stop']);
const OBSERVER_REASON_CODES = new Set<A2AObserverReasonCode>(['MUTUAL_TOPIC_ALIGNMENT', 'COMPLEMENTARY_EXPERIENCE', 'EXPLORABLE_DIVERGENCE', 'ACTIONABLE_NEXT_QUESTION', 'ONE_SIDED_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'CONTRADICTORY_EVIDENCE', 'NO_CLEAR_EXCHANGE_VALUE']);

function freezeSession(session: A2ASession): A2ASession {
  return Object.freeze({ ...session, evidenceLedger: Object.freeze({ entries: Object.freeze([...session.evidenceLedger.entries]) }), turns: Object.freeze([...session.turns]) });
}

function profileEvidence(profile: AgentContextSnapshot, owner: A2AEvidence['owner']): A2AEvidence[] {
  return profile.sections.filter(section => section.publicBoundary === 'public').map(section => Object.freeze({
    id: `${owner}-profile:${profile.profileVersion}:${section.dimension}`,
    owner,
    sourceType: owner === 'requester' ? 'profile' as const : 'candidate_profile' as const,
    excerpt: section.impression,
    quality: 'primary' as const,
    sourceReferences: Object.freeze([...section.sourceReferences])
  }));
}

export function buildA2AEvidenceLedger(recommendation: RecommendationSnapshot, requesterProfile: AgentContextSnapshot, candidateProfile: AgentContextSnapshot): A2AEvidenceLedger {
  const recommendationEvidence = recommendation.evidenceRefs.filter(ref => ref.sourceType !== 'profile' && !!ref.excerpt?.trim()).map(ref => Object.freeze({
    id: `${ref.sourceType}:${ref.sourceId}`,
    owner: 'candidate' as const,
    sourceType: ref.sourceType,
    excerpt: ref.excerpt!.trim(),
    quality: ref.quality || 'self_reported' as const,
    sourceReferences: Object.freeze([...(ref.sourceReferences || [])])
  }));
  const entries = [...profileEvidence(requesterProfile, 'requester'), ...profileEvidence(candidateProfile, 'candidate'), ...recommendationEvidence];
  return Object.freeze({ entries: Object.freeze([...new Map(entries.map(item => [item.id, item])).values()]) });
}

function validateTurn(draft: A2ATurnDraft, ledger: A2AEvidenceLedger, speaker: A2ATurn['speaker'], round: A2ATurn['round']) {
  if (!draft || typeof draft !== 'object' || !TURN_INTENTS.has(draft.intent) || typeof draft.text !== 'string' || !draft.text.trim() || !Array.isArray(draft.claims) || !Array.isArray(draft.questions) || draft.questions.some(question => typeof question !== 'string')) throw new Error('A2A_TURN_INVALID');
  const expectedIntent: A2ATurnIntent = round === 1 ? 'position' : round === 2 ? 'response' : 'summary';
  if (draft.intent !== expectedIntent || (round === 2 && !draft.questions.length)) throw new Error('A2A_TURN_PHASE_INVALID');
  const owner = speaker === 'requester_agent' ? 'requester' : 'candidate';
  const allowed = new Set(ledger.entries.filter(item => item.owner === owner).map(item => item.id));
  for (const claim of draft.claims) {
    if (!claim || typeof claim !== 'object' || typeof claim.text !== 'string' || !claim.text.trim() || !Array.isArray(claim.evidenceRefIds) || !claim.evidenceRefIds.length || claim.evidenceRefIds.some(id => typeof id !== 'string' || !allowed.has(id))) throw new Error('A2A_CLAIM_EVIDENCE_INVALID');
  }
}

function validateObservation(observation: A2AObservationDraft, ledger: A2AEvidenceLedger, turns: readonly A2ATurn[]) {
  if (!observation || typeof observation !== 'object' || !OBSERVER_VERDICTS.has(observation.verdict) || typeof observation.reason !== 'string' || !observation.reason.trim() || !Array.isArray(observation.reasonCodes) || !observation.reasonCodes.length || observation.reasonCodes.some(code => !OBSERVER_REASON_CODES.has(code)) || !Array.isArray(observation.evidenceRefs) || !observation.evidenceRefs.length || (observation.suggestedTopic !== undefined && typeof observation.suggestedTopic !== 'string') || (observation.suggestedOpening !== undefined && typeof observation.suggestedOpening !== 'string')) throw new Error('A2A_OBSERVATION_INVALID');
  const allowed = new Set(ledger.entries.map(item => item.id));
  if (observation.evidenceRefs.some(id => typeof id !== 'string' || !allowed.has(id))) throw new Error('A2A_OBSERVATION_INVALID');
  if (observation.verdict !== 'stop') {
    if (observation.reasonCodes.includes('INSUFFICIENT_EVIDENCE') || observation.reasonCodes.includes('NO_CLEAR_EXCHANGE_VALUE')) throw new Error('A2A_OBSERVATION_EVIDENCE_INSUFFICIENT');
    const cited = new Set(turns.flatMap(turn => turn.claims.flatMap(claim => claim.evidenceRefIds)));
    const owners = new Set(observation.evidenceRefs.map(id => ledger.entries.find(item => item.id === id)?.owner));
    const evidencedSpeakers = new Set(turns.filter(turn => turn.claims.length).map(turn => turn.speaker));
    if (observation.evidenceRefs.some(id => !cited.has(id)) || !owners.has('requester') || !owners.has('candidate') || !evidencedSpeakers.has('requester_agent') || !evidencedSpeakers.has('candidate_agent')) throw new Error('A2A_OBSERVATION_EVIDENCE_INSUFFICIENT');
  }
}

export function createA2ASession(recommendation: RecommendationSnapshot, requesterProfile: AgentContextSnapshot, candidateProfile: AgentContextSnapshot): A2ASession {
  if (recommendation.targetType !== 'person' || recommendation.verdict !== 'recommended' || !recommendation.a2aEligible) throw new Error('A2A_NOT_ELIGIBLE');
  if (requesterProfile.ownerId !== recommendation.ownerId || requesterProfile.profileVersion !== recommendation.profileVersion || !requesterProfile.confirmedAt) throw new Error('A2A_PROFILE_INVALID');
  if (candidateProfile.ownerId !== recommendation.candidateId || !candidateProfile.confirmedAt) throw new Error('A2A_CANDIDATE_PROFILE_INVALID');
  return freezeSession({ id: randomUUID(), requesterId: recommendation.ownerId, candidateId: recommendation.candidateId, recommendationId: recommendation.recommendationId, topic: recommendation.query, status: 'created', currentRound: 0, requesterProfileVersion: requesterProfile.profileVersion, candidateProfileVersion: candidateProfile.profileVersion, evidenceLedger: buildA2AEvidenceLedger(recommendation, requesterProfile, candidateProfile), turns: [], createdAt: new Date().toISOString() });
}

export async function runA2ASession(initial: A2ASession, adapter: A2ASessionAdapter, f05: F05InvitationDraftPort, publish: (session: A2ASession) => void = () => {}): Promise<A2ASession> {
  if (initial.status !== 'created' || initial.currentRound !== 0 || initial.turns.length) throw new Error('A2A_SESSION_STATE_INVALID');
  let session = initial;
  try {
    if (!session.evidenceLedger.entries.some(item => item.owner === 'requester') || !session.evidenceLedger.entries.some(item => item.owner === 'candidate')) throw new Error('A2A_EVIDENCE_INSUFFICIENT');
    for (const round of [1, 2, 3] as const) {
      session = freezeSession({ ...session, status: 'running', currentRound: round }); publish(session);
      for (const speaker of ['requester_agent', 'candidate_agent'] as const) {
        const draft = await adapter.generateTurn({ round, speaker, topic: session.topic, evidenceLedger: session.evidenceLedger, previousTurns: session.turns });
        validateTurn(draft, session.evidenceLedger, speaker, round);
        const turn: A2ATurn = Object.freeze({ id: randomUUID(), round, speaker, intent: draft.intent, text: draft.text.trim(), claims: Object.freeze(draft.claims.map(claim => Object.freeze({ ...claim, evidenceRefIds: Object.freeze([...claim.evidenceRefIds]) }))), questions: Object.freeze([...draft.questions]), createdAt: new Date().toISOString() });
        session = freezeSession({ ...session, turns: [...session.turns, turn] }); publish(session);
      }
    }
    session = freezeSession({ ...session, status: 'observing' }); publish(session);
    const observation = await adapter.observe({ topic: session.topic, evidenceLedger: session.evidenceLedger, turns: session.turns });
    validateObservation(observation, session.evidenceLedger, session.turns);
    if (observation.verdict === 'stop') {
      session = freezeSession({ ...session, status: 'completed', observation: Object.freeze(observation), completedAt: new Date().toISOString() }); publish(session); return session;
    }
    const handoff: F05HandoffPayload = Object.freeze({ source: 'a2a_session', sourceSessionId: session.id, recommendationId: session.recommendationId, senderId: session.requesterId, recipientId: session.candidateId, topic: observation.suggestedTopic || session.topic, suggestedOpening: observation.suggestedOpening || `想继续聊聊「${session.topic}」。`, observerVerdict: observation.verdict, reason: observation.reason, evidenceRefIds: Object.freeze([...observation.evidenceRefs]) });
    session = freezeSession({ ...session, observation: Object.freeze(observation), f05Handoff: handoff }); publish(session);
    const draft = await f05.createDraft(handoff);
    if (!draft || draft.status !== 'draft' || typeof draft.draftId !== 'string' || !draft.draftId) throw new Error('F05_DRAFT_INVALID');
    session = freezeSession({ ...session, status: 'completed', f05DraftId: draft.draftId, completedAt: new Date().toISOString() }); publish(session); return session;
  } catch (error) {
    session = freezeSession({ ...session, status: 'failed', failureCode: error instanceof Error ? error.message : 'A2A_FAILED', completedAt: new Date().toISOString() }); publish(session); return session;
  }
}
