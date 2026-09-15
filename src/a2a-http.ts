import { randomUUID } from 'node:crypto';
import type { A2AAgentTransport } from './a2a-adapter.ts';
import type { A2AObservationDraft, A2AObserverRequest, A2ATurnDraft, A2ATurnRequest } from './a2a-session.ts';

export type A2AHttpTransportOptions = Readonly<{
  baseUrl: string;
  sharedSecret?: string;
  observe: (request: A2AObserverRequest) => Promise<A2AObservationDraft>;
}>;

type JsonRpcResponse = Readonly<{
  jsonrpc?: string;
  id?: string | number | null;
  error?: { code?: number; message?: string };
  result?: { message?: { metadata?: Record<string, unknown>; parts?: { text?: string }[] } };
}>;

function turnMessageId(request: A2ATurnRequest) {
  return `z1space:${request.sessionId}:${request.round}:${request.speaker}`;
}

function turnPayload(request: A2ATurnRequest) {
  return {
    taskId: request.sessionId,
    contextId: request.sessionId,
    messageId: turnMessageId(request),
    role: 'ROLE_USER',
    parts: [{ text: request.previousTurns.at(-1)?.text || `围绕「${request.topic}」开始交流。` }],
    metadata: {
      z1space: {
        agentId: request.agentId,
        agentRole: request.agentRole,
        speaker: request.speaker,
        round: request.round
      }
    }
  };
}

export class HttpA2AAgentTransport implements A2AAgentTransport {
  private readonly options: A2AHttpTransportOptions;
  constructor(options: A2AHttpTransportOptions) { this.options = { ...options, baseUrl: options.baseUrl.replace(/\/$/, '') }; }

  async sendTurn(request: A2ATurnRequest): Promise<A2ATurnDraft> {
    const response = await fetch(`${this.options.baseUrl}/a2a/agents/${encodeURIComponent(request.agentId)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'a2a-version': '1.0',
        ...(this.options.sharedSecret ? { authorization: `Bearer ${this.options.sharedSecret}` } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: { message: turnPayload(request) } }),
      signal: AbortSignal.timeout(35_000)
    });
    const payload = await response.json().catch(() => ({})) as JsonRpcResponse;
    if (!response.ok || payload.error) throw new Error(String(payload.error?.message || `A2A HTTP ${response.status}`));
    const turn = payload.result?.message?.metadata?.z1spaceTurn;
    if (!turn || typeof turn !== 'object') throw new Error('A2A_TURN_RESPONSE_INVALID');
    return turn as A2ATurnDraft;
  }

  observe(request: A2AObserverRequest) { return this.options.observe(request); }
}

export function a2aAgentCard(baseUrl: string, agentId: string, name: string, description: string, mode: 'user' | 'public_profile_proxy' | 'gateway' = 'user') {
  const safeBaseUrl = baseUrl.replace(/\/$/, '');
  return {
    name,
    description,
    supportedInterfaces: [{ url: `${safeBaseUrl}/a2a/agents/${encodeURIComponent(agentId)}`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'a2a-first-chat', name: 'A2A 预交流', description: '基于双方已确认或公开的资料，进行有限轮次的 Agent 预交流。' }],
    metadata: { agentId, mode }
  };
}
