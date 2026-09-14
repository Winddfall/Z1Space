import type { AgentContextSnapshot } from './agent-context.ts';
import type { A2AObservationDraft, A2AObserverRequest, A2ATurnDraft, A2ATurnRequest, F05HandoffPayload } from './a2a-session.ts';

export type A2AEvaluationRequest = Readonly<{
  requesterId: string;
  candidateId: string;
  profileVersion: number;
  topic: string;
  recommendationId: string;
  evidenceRefIds: readonly string[];
}>;

export type A2AEvaluationResult = Readonly<{
  eligible: boolean;
  reasons: readonly string[];
}>;

export interface A2AAdapter {
  evaluate(request: A2AEvaluationRequest): Promise<A2AEvaluationResult>;
}

export interface CandidateProfileProvider {
  getPublicProfile(candidateId: string): Promise<AgentContextSnapshot | null>;
}

export interface A2ASessionAdapter {
  generateTurn(request: A2ATurnRequest): Promise<A2ATurnDraft>;
  observe(request: A2AObserverRequest): Promise<A2AObservationDraft>;
}

export interface F05InvitationDraftPort {
  createDraft(payload: F05HandoffPayload): Promise<Readonly<{ draftId: string; status: 'draft' }>>;
}

export class InMemoryCandidateProfileProvider implements CandidateProfileProvider {
  private readonly profiles: Readonly<Record<string, AgentContextSnapshot>>;
  constructor(profiles: Readonly<Record<string, AgentContextSnapshot>>) { this.profiles = profiles; }
  async getPublicProfile(candidateId: string) { return this.profiles[candidateId] || null; }
}

export class FakeA2ASessionAdapter implements A2ASessionAdapter {
  private readonly observerVerdict: A2AObservationDraft['verdict'];
  constructor(observerVerdict: A2AObservationDraft['verdict'] = 'proceed') { this.observerVerdict = observerVerdict; }

  async generateTurn(request: A2ATurnRequest): Promise<A2ATurnDraft> {
    const owner = request.speaker === 'requester_agent' ? 'requester' : 'candidate';
    const evidence = request.evidenceLedger.entries.find(item => item.owner === owner);
    const phase = request.round === 1 ? '陈述相关经历' : request.round === 2 ? '提出问题并回应' : '确认共识、分歧和信息增量';
    return {
      intent: request.round === 1 ? 'position' : request.round === 2 ? 'response' : 'summary',
      text: evidence ? `${phase}：${evidence.excerpt}` : `${phase}：目前没有足够证据支持事实陈述。`,
      claims: evidence ? [{ text: evidence.excerpt, evidenceRefIds: [evidence.id] }] : [],
      questions: request.round === 2 ? [`你如何看待「${request.topic}」？`] : []
    };
  }

  async observe(request: A2AObserverRequest): Promise<A2AObservationDraft> {
    const evidenceRefs = ['requester', 'candidate'].map(owner => request.evidenceLedger.entries.find(item => item.owner === owner)?.id).filter((id): id is string => !!id);
    if (this.observerVerdict === 'stop') return { verdict: 'stop', reason: '三轮预交流没有形成足够的双向交流价值。', reasonCodes: ['NO_CLEAR_EXCHANGE_VALUE'], evidenceRefs };
    return {
      verdict: this.observerVerdict,
      reason: this.observerVerdict === 'proceed' ? '双方都有公开证据支持的相关经历，适合由用户决定是否继续交流。' : '存在交流价值，但仍需要用户检查上下文后决定。',
      reasonCodes: this.observerVerdict === 'proceed' ? ['MUTUAL_TOPIC_ALIGNMENT', 'COMPLEMENTARY_EXPERIENCE'] : ['ONE_SIDED_EVIDENCE'],
      evidenceRefs,
      suggestedTopic: request.topic,
      suggestedOpening: `想继续聊聊「${request.topic}」中双方提到的具体经历。`
    };
  }
}

export class InMemoryF05InvitationDraftPort implements F05InvitationDraftPort {
  readonly payloads: F05HandoffPayload[] = [];
  private nextId = 1;
  async createDraft(payload: F05HandoffPayload) { this.payloads.push(payload); if (this.payloads.length > 500) this.payloads.shift(); return { draftId: `draft-${this.nextId++}`, status: 'draft' as const }; }
}
