import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildAgentContextSnapshot, type AgentContextSnapshot } from './agent-context.ts';
import { recallContent, recallPeople, type ContentCandidate, type PeopleCandidate, type Recommendation } from './explore.ts';
import { routeTrigger, type TriggerEvent } from './trigger-router.ts';
import { clearSessionCookie, setSessionCookie, readCookie } from './auth/cookie.ts';
import { SessionStore } from './auth/session-store.ts';
import { OAuthStateStore } from './auth/oauth-state.ts';
import { authorizationUrl, exchangeCode, fetchUser, fetchUserData } from './zhihu/zhihu-oauth-client.ts';
import { readZhihuOAuthConfig } from './zhihu/oauth-config.ts';
import { redirect } from './http/response.ts';
import { searchZhihuUsers, zhihuAuthorId } from './zhihu/skill-search.ts';
import { HumanChatError, HumanChatStore } from './human-chat/store.ts';
import type { HumanUser } from './human-chat/types.ts';
import { FakeA2ASessionAdapter, InMemoryCandidateProfileProvider, InMemoryF05InvitationDraftPort } from './a2a-adapter.ts';
import { createA2ASession, runA2ASession, type A2ASession, type RecommendationSnapshot } from './a2a-session.ts';
import { extractSkillDiscoveryIntent } from './skill-discovery-bridge.ts';

type Skill = { id: string; name: string; kind?: string; goal?: string; keywords?: string; enabled?: boolean; profileDescription?: string; profileTitle?: string; [key: string]: unknown };
type AppState = { version: number; step: string; name: string; impressions: string[]; skills: Skill[]; following: string[]; liked: string[]; saved: string[]; chats: Record<string, unknown>; runs: unknown[]; discoverIds: string[]; contentIds: string[]; lastView: string; agentChats?: Record<string, AgentMessage[]>; [key: string]: unknown };
type AgentMessage = { from: 'me' | 'agent'; text: string; time: string };
type Person = { id: string; name: string; role: string; bio: string; tags: string[]; reason: string; topic: string; greeting: string; url?: string };
type Run = { id: string; skill: Skill; createdAt: number; status: 'running' | 'completed'; stage: number; timeline: { text: string; kind: 'agent' | 'user' }[]; matches: string[]; people: Record<string, Person>; llmReady?: boolean; llmError?: string };
type TriggeredRun = Run & { ownerId: string; profileSnapshot: AgentContextSnapshot };

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.Z1SPACE_DATA_DIR || join(root, '.data');
const stateFile = join(dataDir, 'sessions.json');
const sessions = new Map<string, AppState>();
const runs = new Map<string, TriggeredRun>();
const agentChats = new Map<string, AgentMessage[]>();
const requestSessions = new WeakMap<IncomingMessage, string>();
const authSessions = new SessionStore();
const oauthStates = new OAuthStateStore();
const zhihuOAuth = readZhihuOAuthConfig();
const humanChatStore = new HumanChatStore(join(dataDir, 'human-chats.json'));
await humanChatStore.load();
const recommendationSnapshots = new Map<string, RecommendationSnapshot>();
const maxRecommendationSnapshotsPerOwner = 100;
const a2aSessions = new Map<string, A2ASession>();
const a2aIdempotency = new Map<string, string>();
const maxA2ASessions = 500;
const maxA2ASessionsPerOwner = 20;
const maxConcurrentA2ASessions = 20;
const maxConcurrentA2ASessionsPerOwner = 2;

const people: Record<string, Person> = {
  chen: { id: 'chen', name: '陈序', role: '独立开发者 · AI 产品实践', bio: '在做让复杂任务变简单的工具。写过代码，也踩过产品的坑。', tags: ['AI 产品', '独立开发', '交互'], reason: '他有 AI 产品落地经验，与你都在思考如何把复杂任务变简单。', topic: 'AI 产品应该先做聊天入口，还是任务流程？', greeting: '你好，我是陈序。看到你也在研究 AI 产品入口，我正好有一次改版经历可以分享。' },
  xia: { id: 'xia', name: '许知夏', role: '用户研究员 · 关注人与技术', bio: '喜欢把“用户需要什么”问得再具体一点。', tags: ['用户研究', '产品', 'AI'], reason: '她关注 AI 如何进入真实场景，与你对真实用户需求的兴趣一致。', topic: '做第一个 AI 产品时，应该先问用户什么？', greeting: '你好呀，我是知夏。很想听听你最近遇到的真实用户问题。' },
  zhou: { id: 'zhou', name: '周予', role: '交互设计师 · 自由创作者', bio: '关心界面的细节，也关心一个产品给人的感觉。', tags: ['交互设计', 'AI 产品', '设计'], reason: '他习惯从具体交互讨论产品取舍，与你关注的问题直接相关。', topic: 'Agent 应该主动到什么程度？', greeting: '你好，我是周予。最近也在画 Agent 产品的交互流程，可以一起聊聊。' }
};

const contents: ContentCandidate[] = [
  { id: 'p1', authorId: 'chen', title: '做了三个月 AI 工具，我把聊天框从首页拿掉了', excerpt: '把高频任务和开放探索分开，让用户更容易开始。', tags: ['AI 产品', '独立开发', '交互'] },
  { id: 'p3', authorId: 'zhou', title: 'Agent 的主动性，需要一个让人放心的边界', excerpt: '展示 Agent 正在查找什么、分享什么，以及下一步由谁确认。', tags: ['Agent', '交互设计', 'AI 产品'] },
  { id: 'p5', title: '我不再追求整理好所有笔记', excerpt: '让知识在具体问题里被调用，比保持目录整齐更重要。', tags: ['知识管理', '阅读', '学习'] }
];

const candidateProfileProvider = new InMemoryCandidateProfileProvider(Object.fromEntries(Object.values(people).map(person => [person.id, buildAgentContextSnapshot({ profileVersion: 1, profileConfirmedAt: '2026-09-14T00:00:00.000Z', impressions: [`${person.name}的公开身份与实践方向：${person.role}。`, `${person.name}的公开介绍：${person.bio}`, `${person.name}愿意围绕这个公开话题交流：${person.topic}`], profileSourceReferences: [[`candidate:${person.id}:role`], [`candidate:${person.id}:bio`], [`candidate:${person.id}:topic`]], profilePublicBoundaries: ['public', 'public', 'public'] }, person.id)])));
const a2aAdapter = new FakeA2ASessionAdapter();
const f05DraftPort = new InMemoryF05InvitationDraftPort();

function fresh(): AppState { return { version: 1, step: 'auth', name: '', impressions: [], skills: [], following: [], liked: [], saved: [], chats: {}, runs: [], discoverIds: ['chen', 'xia', 'zhou'], contentIds: [], lastView: 'discover', agentChats: {} }; }
function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); }
class RequestBodyTooLarge extends Error {}
async function body(req: IncomingMessage, maxBytes = Infinity) { let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > maxBytes) throw new RequestBodyTooLarge(); } return raw ? JSON.parse(raw) : {}; }
function sessionId(req: IncomingMessage, res: ServerResponse) { const cached = requestSessions.get(req); if (cached) return cached; const cookie = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('z1space_session=')); const supplied = cookie ? decodeURIComponent(cookie.slice('z1space_session='.length)) : ''; const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied) ? supplied : randomUUID(); requestSessions.set(req, id); if (id !== supplied) res.setHeader('set-cookie', `z1space_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict`); return id; }
async function saveSessions() { await mkdir(dataDir, { recursive: true }); await writeFile(stateFile, JSON.stringify(Object.fromEntries(sessions), null, 2)); }
async function loadSessions() { if (!existsSync(stateFile)) return; try { const saved = JSON.parse(await readFile(stateFile, 'utf8')); for (const [id, value] of Object.entries(saved)) sessions.set(id, value as AppState); } catch { /* a corrupt demo file should not block a fresh session */ } }
function currentState(req: IncomingMessage, res: ServerResponse) { const id = sessionId(req, res); if (!sessions.has(id)) sessions.set(id, fresh()); return sessions.get(id)!; }
function authSession(req: IncomingMessage) { return authSessions.getOrCreate(req); }
function secureCookies(req: IncomingMessage) { return req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'; }
function authError(res: ServerResponse, message: string) { return redirect(res, `/?auth=error&reason=${encodeURIComponent(message)}`); }
function humanUser(req: IncomingMessage, url: URL, res: ServerResponse): HumanUser {
  const selected = String(req.headers['x-z1-demo-user'] || url.searchParams.get('demoUser') || 'a').toLowerCase() === 'b' ? 'b' : 'a';
  return { id: `${sessionId(req, res)}:${selected}`, name: selected === 'b' ? '演示用户 B' : '演示用户 A' };
}
function profileDescription(skill: Skill) { const goal = String(skill.goal || '').trim().replace(/[。.!！?？]+$/, ''); return goal ? `正在通过 Agent：${goal}，并把这轮探索中形成的连接沉淀为个人画像。` : `正在使用「${skill.name}」探索值得认识的人与信息。`; }
function runFor(skill: Skill): Run { return { id: randomUUID(), skill, createdAt: Date.now(), status: 'running', stage: 0, timeline: [{ kind: 'agent', text: `收到，我开始执行「${skill.name}」。我会先理解你的目标，再寻找有依据的连接。` }], matches: [], people: {}, llmReady: false }; }
function triggeredRun(skill: Skill, ownerId: string, profileSnapshot: AgentContextSnapshot): TriggeredRun { return { ...runFor(skill), ownerId, profileSnapshot }; }
function publicRun(run: TriggeredRun) { const { ownerId: _ownerId, profileSnapshot: _profileSnapshot, ...value } = run; const discoveryIntent = extractSkillDiscoveryIntent(run); return { ...value, people: run.people, profileVersion: run.profileSnapshot.profileVersion, ...(discoveryIntent ? { discoveryIntent } : {}) }; }
function trigger(type: TriggerEvent['type'], ownerId: string, payload: Record<string, unknown>, source: TriggerEvent['source'] = 'web'): TriggerEvent { const eventId = randomUUID(); return { schemaVersion: 1, eventId, type, occurredAt: new Date().toISOString(), source, actor: { userId: ownerId, sessionId: ownerId }, correlationId: eventId, payload }; }
function snapshotFor(state: AppState, ownerId: string) { try { return buildAgentContextSnapshot(state, ownerId); } catch { return null; } }
function routeError(res: ServerResponse, plan: { accepted: false; code: string }) { const status = plan.code === 'PROFILE_NOT_CONFIRMED' || plan.code === 'SKILL_DISABLED' ? 409 : 400; return json(res, status, { error: plan.code }); }
function recommendationKey(ownerId: string, recommendationId: string) { return `${ownerId}:${recommendationId}`; }
function saveRecommendationSnapshots(ownerId: string, query: string, profileVersion: number, recommendations: readonly Recommendation[]) { return recommendations.map(recommendation => { const stored = Object.freeze({ ...recommendation, id: randomUUID() }); recommendationSnapshots.set(recommendationKey(ownerId, stored.id), Object.freeze({ recommendationId: stored.id, ownerId, candidateId: stored.targetId, targetType: stored.targetType, query, profileVersion, verdict: stored.verdict, a2aEligible: stored.a2aEligible, a2aReasons: Object.freeze([...stored.a2aReasons]), evidenceRefs: Object.freeze([...stored.evidenceRefs]), createdAt: new Date().toISOString() })); const ownerPrefix = `${ownerId}:`; while ([...recommendationSnapshots.keys()].filter(key => key.startsWith(ownerPrefix)).length > maxRecommendationSnapshotsPerOwner) recommendationSnapshots.delete([...recommendationSnapshots.keys()].find(key => key.startsWith(ownerPrefix))!); return stored.targetType === 'person' && stored.a2aEligible ? Object.freeze({ ...stored, a2aSessionEndpoint: '/api/a2a-sessions' as const }) : stored; }); }
function removeA2ASession(sessionId: string) { a2aSessions.delete(sessionId); for (const [key, value] of a2aIdempotency) if (value === sessionId) a2aIdempotency.delete(key); }
function pruneA2ASessions(ownerId: string) { const terminal = (session: A2ASession) => session.status === 'completed' || session.status === 'failed'; while ([...a2aSessions.values()].filter(session => session.requesterId === ownerId).length >= maxA2ASessionsPerOwner) { const oldest = [...a2aSessions.values()].find(session => session.requesterId === ownerId && terminal(session)); if (!oldest) break; removeA2ASession(oldest.id); } while (a2aSessions.size >= maxA2ASessions) { const oldest = [...a2aSessions.values()].find(terminal); if (!oldest) break; removeA2ASession(oldest.id); } }
function hasA2ACapacity(ownerId: string) { const sessions = [...a2aSessions.values()]; const active = sessions.filter(session => session.status === 'created' || session.status === 'running' || session.status === 'observing'); return active.length < maxConcurrentA2ASessions && active.filter(session => session.requesterId === ownerId).length < maxConcurrentA2ASessionsPerOwner && sessions.length < maxA2ASessions && sessions.filter(session => session.requesterId === ownerId).length < maxA2ASessionsPerOwner; }

const deepseekBaseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
async function deepseekChat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], options: Record<string, unknown> = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const response = await fetch(`${deepseekBaseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: deepseekModel, messages, temperature: 0.4, ...options }) });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  return payload.choices?.[0]?.message?.content?.trim() || '';
}
async function enrichRun(run: Run) {
  const query = `${run.skill.goal || ''} ${run.skill.keywords || ''}`.trim() || run.skill.name;
  try {
    const results = await searchZhihuUsers(query, 10);
    for (const result of results) {
      const id = zhihuAuthorId(result);
      if (!run.people[id]) run.people[id] = {
        id,
        name: result.authorName,
        role: '知乎用户 · 来自知乎搜索',
        bio: result.excerpt || `在知乎分享「${result.title}」相关经验。`,
        tags: [query].filter(Boolean),
        reason: `知乎搜索中发现其分享过「${result.title}」，与“${query}”直接相关。`,
        topic: result.title,
        greeting: `你好，看到你在知乎分享「${result.title}」，我也在关注“${query}”，想了解你的实践经历。`,
        url: result.url
      };
      if (!run.matches.includes(id)) run.matches.push(id);
    }
    if (!results.length) run.timeline.push({ kind: 'agent', text: `知乎搜索暂未返回“${query}”对应的公开用户结果。` });
  } catch (error) {
    run.llmError = error instanceof Error ? error.message : '知乎搜索失败';
    run.timeline.push({ kind: 'agent', text: '知乎 Skill 暂时无法完成真实搜索，请检查 CLI 认证或网络连接。' });
  }
  if (!process.env.DEEPSEEK_API_KEY || !run.matches.length) { run.llmReady = true; return; }
  try {
    const candidateList = run.matches.map(id => run.people[id]).filter(Boolean).map(p => ({ id: p.id, name: p.name, role: p.role, bio: p.bio, tags: p.tags, topic: p.topic }));
    const content = await deepseekChat([
      { role: 'system', content: '你是 Z1Space 的匹配 Agent。请基于用户 Skill 和候选人的公开简介，给出可靠、克制、有行动价值的匹配结果。只输出 JSON，格式为 {"matches":[{"id":"候选人id","reason":"不超过80字的匹配理由","opening":"一个适合用户继续询问对方 Agent 的问题"}],"summary":"不超过80字的总结"}。不要编造候选人资料。' },
      { role: 'user', content: JSON.stringify({ skill: run.skill, candidates: candidateList }) }
    ], { response_format: { type: 'json_object' }, max_tokens: 700 });
    const parsed = JSON.parse(content || '{}') as { matches?: { id: string; reason?: string; opening?: string }[]; summary?: string };
    const enriched = (parsed.matches || []).filter(x => run.people[x.id]);
    if (enriched.length) run.matches = enriched.map(x => x.id);
    if (parsed.summary) run.timeline.push({ kind: 'agent', text: parsed.summary });
    for (const match of enriched) { if (match.reason && run.people[match.id]) run.people[match.id].reason = match.reason; if (match.opening && run.people[match.id]) { run.people[match.id].topic = match.opening; run.people[match.id].greeting = `你好，关于“${query}”，我想和你继续交流：${match.opening}`; } }
  } catch (error) { run.llmError = error instanceof Error ? error.message : 'DeepSeek request failed'; run.timeline.push({ kind: 'agent', text: '模型暂时不可用，我先用知乎搜索结果继续。' }); }
  run.llmReady = true;
}
function advance(run: Run) { const elapsed = Date.now() - run.createdAt; const stage = Math.min(run.llmReady ? 3 : 2, Math.floor(elapsed / 650)); while (run.stage < stage) { run.stage += 1; if (run.stage === 1) run.timeline.push({ kind: 'agent', text: '我正在把你的需求拆成几个可匹配的线索，避免只按关键词机械搜索。' }); if (run.stage === 2) run.timeline.push({ kind: 'agent', text: `我找到了 ${run.matches.length} 位可能有帮助的人，正在整理他们与你的共同话题。` }); if (run.stage === 3) { run.status = 'completed'; run.timeline.push({ kind: 'agent', text: '有结果了。下面的人物卡片来自本次任务的匹配依据，你可以先与他们的 Agent 交流，了解更多情况。' }); } } return run; }
function staticPath(pathname: string) { if (pathname === '/') return join(root, 'Z1Space.html'); if (pathname === '/z1space-client.js') return join(root, 'public', 'z1space-client.js'); return null; }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,X-Z1-Session' }); return res.end(); }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'z1space-api' });
    if (url.pathname === '/api/auth/session' && req.method === 'GET') {
      const session = authSession(req);
      if (!readCookie(req, 'z1_session')) setSessionCookie(res, session.id, secureCookies(req));
      return json(res, 200, { ...authSessions.publicView(session), oauthConfigured: zhihuOAuth.configured });
    }
    if (url.pathname === '/auth/zhihu/start' && req.method === 'GET') {
      const session = authSession(req);
      setSessionCookie(res, session.id, secureCookies(req));
      if (!zhihuOAuth.configured) return redirect(res, '/?auth=demo');
      return redirect(res, authorizationUrl(zhihuOAuth, oauthStates.create(session.id)));
    }
    if (url.pathname === '/auth/zhihu/callback' && req.method === 'GET') {
      const session = authSession(req);
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('authorization_code') || url.searchParams.get('code');
      const providerError = url.searchParams.get('error');
      if (providerError) { oauthStates.consume(state, session.id); return authError(res, '你取消了知乎授权，请重试。'); }
      if (!oauthStates.consume(state, session.id)) return authError(res, '授权状态已失效，请重新开始知乎授权。');
      if (!code) return authError(res, '知乎没有返回授权码。');
      try { const token = await exchangeCode(zhihuOAuth, code); const user = await fetchUser(token.accessToken); const userData = await fetchUserData(zhihuOAuth.accessSecret, token.accessToken); authSessions.setToken(session.id, token, user, userData); setSessionCookie(res, session.id, secureCookies(req)); return redirect(res, '/?auth=success'); }
      catch (error) { console.error('Zhihu OAuth callback failed:', error instanceof Error ? error.message : 'unknown error'); return authError(res, '知乎授权完成了，但读取公开资料失败，请稍后重试。'); }
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') { const id = readCookie(req, 'z1_session'); if (id) authSessions.delete(id); clearSessionCookie(res); return json(res, 200, { ok: true }); }
    const human = humanUser(req, url, res);
    if (url.pathname === '/api/human/overview' && req.method === 'GET') return json(res, 200, humanChatStore.overview(human));
    if (url.pathname === '/api/human/invitations' && req.method === 'POST') return json(res, 201, await humanChatStore.createInvitation(human, await body(req)));
    const invitationMatch = url.pathname.match(/^\/api\/human\/invitations\/([^/]+)(?:\/(claim|accept|reject|withdraw))?$/);
    if (invitationMatch) {
      const id = invitationMatch[1];
      if (!invitationMatch[2] && req.method === 'GET') return json(res, 200, await humanChatStore.claim(human, id, url.searchParams.get('token') || ''));
      if (invitationMatch[2] === 'claim' && req.method === 'POST') { const input = await body(req) as { token?: string }; return json(res, 200, await humanChatStore.claim(human, id, String(input.token || ''))); }
      if (invitationMatch[2] && req.method === 'POST') return json(res, 200, await humanChatStore.act(human, id, invitationMatch[2] as 'accept' | 'reject' | 'withdraw'));
    }
    const conversationMatch = url.pathname.match(/^\/api\/human\/conversations\/([^/]+)(?:\/(messages|read))?$/);
    if (conversationMatch) {
      const id = conversationMatch[1];
      if (!conversationMatch[2] && req.method === 'GET') return json(res, 200, humanChatStore.conversation(human.id, id));
      if (conversationMatch[2] === 'messages' && req.method === 'POST') return json(res, 201, await humanChatStore.send(human.id, id, await body(req)));
      if (conversationMatch[2] === 'read' && req.method === 'POST') { const input = await body(req) as { seq?: number }; return json(res, 200, await humanChatStore.read(human.id, id, Number(input.seq || 0))); }
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, currentState(req, res));
    if (url.pathname === '/api/state' && req.method === 'PUT') { const next = await body(req) as AppState; const id = sessionId(req, res); sessions.set(id, { ...fresh(), ...next, version: 1 }); await saveSessions(); return json(res, 200, sessions.get(id)); }
    if (url.pathname === '/api/runs' && req.method === 'POST') { const input = await body(req) as { skill?: Skill }; const state = currentState(req, res); const ownerId = sessionId(req, res); const profile = snapshotFor(state, ownerId); const requestedSkill = input.skill && state.skills.find(skill => skill.id === input.skill?.id); const event = trigger('skill_run.requested', ownerId, { skillId: input.skill?.id }); const activeRun = [...runs.values()].filter(run => run.ownerId === ownerId && run.skill.id === input.skill?.id).map(run => advance(run)).find(run => run.status === 'running'); const plan = routeTrigger(event, { actorId: ownerId, profile, skills: state.skills, ...(activeRun ? { activeRun: { runId: activeRun.id, skillId: activeRun.skill.id } } : {}) }); if (!plan.accepted) return routeError(res, plan); if (plan.destination !== 'skill-runner' || !profile || !requestedSkill) return json(res, 400, { error: 'SKILL_NOT_FOUND' }); if (plan.existingRunId) { const existing = runs.get(plan.existingRunId)!; return json(res, 202, { ...publicRun(advance(existing)), people }); } const run = triggeredRun(requestedSkill, ownerId, profile); runs.set(run.id, run); void enrichRun(run); state.runs = [...(state.runs || []), { id: run.id, skillId: requestedSkill.id, createdAt: run.createdAt }]; await saveSessions(); return json(res, 202, { ...publicRun(advance(run)), people }); }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/); if (runMatch && req.method === 'GET') { const run = runs.get(runMatch[1]); if (!run || run.ownerId !== sessionId(req, res)) return json(res, 404, { error: 'RUN_NOT_FOUND' }); return json(res, 200, { ...publicRun(advance(run)), people }); }
    const discoverMatch = url.pathname.match(/^\/api\/discover\/(people|content)$/); if (discoverMatch && req.method === 'GET') { const state = currentState(req, res); const ownerId = sessionId(req, res); const profile = snapshotFor(state, ownerId); const skillId = url.searchParams.get('skill_id') || undefined; const runId = url.searchParams.get('run_id') || undefined; const limit = Number(url.searchParams.get('limit') || 10); const event = trigger('explore.requested', ownerId, { target: discoverMatch[1], ...(skillId ? { skillId } : {}), ...(runId ? { runId } : {}), limit }); const plan = routeTrigger(event, { actorId: ownerId, profile, skills: state.skills }); if (!plan.accepted) return routeError(res, plan); if (plan.destination !== 'explore' || !profile) return json(res, 400, { error: 'INVALID_EVENT' }); const run = plan.runId ? runs.get(plan.runId) : undefined; if (plan.runId && !run) return json(res, 404, { error: 'RUN_NOT_FOUND' }); if (run && run.ownerId !== ownerId) return json(res, 404, { error: 'RUN_NOT_FOUND' }); if (run) advance(run); const discoveryIntent = run && plan.target === 'people' ? extractSkillDiscoveryIntent(run) : null; if (run && plan.target === 'people' && !discoveryIntent) return json(res, 409, { error: 'RUN_NOT_COMPLETED' }); const skill = (plan.skillId ? state.skills.find(item => item.id === plan.skillId) : undefined) || run?.skill; const query = url.searchParams.get('q') || discoveryIntent?.query || `${skill?.goal || ''} ${skill?.keywords || ''}`.trim() || profile.sections.filter(section => section.publicBoundary === 'public').map(section => section.impression).join(' '); if (plan.target === 'people') { const pool: PeopleCandidate[] = Object.values(people).map(({ id, name, role, bio, tags, topic }) => ({ id, name, role, bio, tags, topic })); const result = recallPeople(pool, query, profile, plan.limit); return json(res, 200, { ...result, ...(discoveryIntent ? { sourceIntent: discoveryIntent } : {}), recommendations: saveRecommendationSnapshots(ownerId, query, profile.profileVersion, result.recommendations) }); } const result = recallContent(contents, query, profile, plan.limit); return json(res, 200, { ...result, recommendations: saveRecommendationSnapshots(ownerId, query, profile.profileVersion, result.recommendations) }); }
    if (url.pathname === '/api/a2a-sessions' && req.method === 'POST') { const input = await body(req, 2_048) as { recommendationId?: unknown; idempotencyKey?: unknown }; const ownerId = sessionId(req, res); if (typeof input.recommendationId !== 'string' || !input.recommendationId || input.recommendationId.length > 128 || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 128) return json(res, 400, { error: 'INVALID_A2A_REQUEST' }); const key = `${ownerId}:${input.recommendationId}:${input.idempotencyKey}`; const existingId = a2aIdempotency.get(key); if (existingId) { const existing = a2aSessions.get(existingId); if (existing) return json(res, 202, existing); a2aIdempotency.delete(key); } const recommendation = recommendationSnapshots.get(recommendationKey(ownerId, input.recommendationId)); if (!recommendation) return json(res, 404, { error: 'RECOMMENDATION_NOT_FOUND' }); if (recommendation.targetType !== 'person' || recommendation.verdict !== 'recommended' || !recommendation.a2aEligible) return json(res, 409, { error: 'A2A_NOT_ELIGIBLE' }); pruneA2ASessions(ownerId); if (!hasA2ACapacity(ownerId)) return json(res, 429, { error: 'A2A_CAPACITY_REACHED' }); const profile = snapshotFor(currentState(req, res), ownerId); if (!profile?.confirmedAt || profile.profileVersion !== recommendation.profileVersion) return json(res, 409, { error: 'PROFILE_VERSION_CHANGED' }); if (!people[recommendation.candidateId]) return json(res, 404, { error: 'CANDIDATE_NOT_FOUND' }); const candidateProfile = await candidateProfileProvider.getPublicProfile(recommendation.candidateId); if (!candidateProfile) return json(res, 404, { error: 'CANDIDATE_PROFILE_NOT_FOUND' }); const racedId = a2aIdempotency.get(key); if (racedId) return json(res, 202, a2aSessions.get(racedId)); if (!hasA2ACapacity(ownerId)) return json(res, 429, { error: 'A2A_CAPACITY_REACHED' }); const session = createA2ASession(recommendation, profile, candidateProfile); a2aSessions.set(session.id, session); a2aIdempotency.set(key, session.id); void runA2ASession(session, a2aAdapter, f05DraftPort, updated => a2aSessions.set(updated.id, updated)); return json(res, 202, session); }
    const a2aMatch = url.pathname.match(/^\/api\/a2a-sessions\/([^/]+)$/); if (a2aMatch && req.method === 'GET') { const session = a2aSessions.get(a2aMatch[1]); if (!session || session.requesterId !== sessionId(req, res)) return json(res, 404, { error: 'A2A_SESSION_NOT_FOUND' }); return json(res, 200, session); }
    const chatMatch = url.pathname.match(/^\/api\/agent-chats\/([^/]+)\/messages$/); if (chatMatch && req.method === 'POST') { const person = people[chatMatch[1]]; if (!person) return json(res, 404, { error: 'PERSON_NOT_FOUND' }); const input = await body(req) as { text?: string }; const messages = agentChats.get(person.id) || [{ from: 'agent', text: person.greeting, time: new Date().toISOString() }]; if (input.text?.trim()) { messages.push({ from: 'me', text: input.text.trim(), time: new Date().toISOString() }); let reply = `围绕「${person.topic}」，我的建议是先从具体经历聊起。你也可以问我：${person.reason}`; try { reply = await deepseekChat([{ role: 'system', content: `你是 ${person.name} 的个人 Agent，只能根据以下公开画像回答。你不是本人，不要冒充真人；语气友好、具体，回答控制在180字内，并给出一个可继续交流的问题。画像：${JSON.stringify(person)}` }, ...messages.slice(-8).map(m => ({ role: m.from === 'me' ? 'user' as const : 'assistant' as const, content: m.text }))]) || reply; } catch { /* keep a deterministic fallback when the provider is unavailable */ } messages.push({ from: 'agent', text: reply, time: new Date().toISOString() }); } agentChats.set(person.id, messages); return json(res, 200, { person, messages, provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'fallback' }); }
    const file = staticPath(url.pathname); if (file) { const content = await readFile(file); const type = extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'; res.writeHead(200, { 'content-type': type }); return res.end(content); }
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) { if (error instanceof RequestBodyTooLarge) return json(res, 413, { error: 'REQUEST_TOO_LARGE' }); if (error instanceof HumanChatError) return json(res, error.status, { error: error.code }); console.error(error); return json(res, 500, { error: 'INTERNAL_ERROR' }); }
});
await loadSessions();
const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Z1Space running at http://localhost:${port}`));
