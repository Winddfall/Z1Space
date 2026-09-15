import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpA2AAgentTransport, a2aAgentCard } from '../src/a2a-http.ts';

test('publishes an A2A Agent Card with a JSON-RPC interface', () => {
  const card = a2aAgentCard('https://example.test', 'agent:one', 'One Agent', '公开画像 Agent', 'user');
  assert.equal(card.metadata.agentId, 'agent:one');
  assert.equal(card.metadata.mode, 'user');
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
  assert.match(card.supportedInterfaces[0].url, /\/a2a\/agents\/agent%3Aone$/);
});

test('sends a real JSON-RPC SendMessage request and reads the Agent turn', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: requestBody.id, result: { message: { metadata: { z1spaceTurn: { intent: 'position', text: '收到。', claims: [{ text: '证据', evidenceRefIds: ['candidate-profile:1:thinking'] }], questions: [] } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const transport = new HttpA2AAgentTransport({ baseUrl: 'http://127.0.0.1:3000', sharedSecret: 'secret', observe: async () => ({ verdict: 'stop', reason: 'test', reasonCodes: ['NO_CLEAR_EXCHANGE_VALUE'], evidenceRefs: [] }) });
    const result = await transport.sendTurn({ sessionId: 'task-1', round: 1, speaker: 'candidate_agent', agentId: 'agent:candidate', agentRole: 'candidate', topic: 'AI', evidenceLedger: { entries: [] }, previousTurns: [] });
    assert.equal(result.text, '收到。');
    assert.equal(requestBody?.method, 'SendMessage');
    const params = requestBody?.params as { message: { taskId: string; metadata: { z1space: { agentId: string } } } };
    assert.equal(params.message.taskId, 'task-1');
    assert.equal(params.message.metadata.z1space.agentId, 'agent:candidate');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
