import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { buildAgentContextSnapshot, type AgentContextSnapshot } from './agent-context.ts';
import { recallContent, recallPeople, type ContentCandidate, type PeopleCandidate, type Recommendation } from './explore.ts';
import { routeTrigger, type TriggerEvent } from './trigger-router.ts';
import { clearSessionCookie, setSessionCookie, readCookie } from './auth/cookie.ts';
import { SessionStore } from './auth/session-store.ts';
import { OAuthStateStore } from './auth/oauth-state.ts';
import { authorizationUrl, exchangeCode, fetchUser, fetchUserData } from './zhihu/zhihu-oauth-client.ts';
import { readZhihuOAuthConfig } from './zhihu/oauth-config.ts';
import { redirect } from './http/response.ts';
import { searchZhihu, zhihuAuthorId, zhihuContentId } from './zhihu/skill-search.ts';
import { HumanChatError, HumanChatStore } from './human-chat/store.ts';
import type { HumanUser } from './human-chat/types.ts';
import { InMemoryCandidateProfileProvider, InMemoryF05InvitationDraftPort, TransportA2ASessionAdapter } from './a2a-adapter.ts';
import { createA2ASession, runA2ASession, type A2AObservationDraft, type A2AObserverRequest, type A2ASession, type A2ATurnDraft, type A2ATurnRequest, type RecommendationSnapshot } from './a2a-session.ts';
import { extractSkillDiscoveryIntent, skillDiscoveryQuery } from './skill-discovery-bridge.ts';
import { HttpA2AAgentTransport, a2aAgentCard } from './a2a-http.ts';
import { A2AStateStore, type A2AStoredState } from './a2a-store.ts';

type Skill = { id: string; name: string; kind?: string; goal?: string; keywords?: string; enabled?: boolean; profileDescription?: string; profileTitle?: string; [key: string]: unknown };
type AppState = { agentId?: string; version: number; step: string; name: string; impressions: string[]; skills: Skill[]; following: string[]; feedIds?: string[]; liked: string[]; saved: string[]; chats: Record<string, unknown>; runs: unknown[]; discoverIds: string[]; contentIds: string[]; lastView: string; updatedAt?: number; people?: Record<string, Person>; posts?: Record<string, Post>; agentChats?: Record<string, AgentMessage[]>; [key: string]: unknown };
type AgentMessage = { from: 'me' | 'agent'; text: string; time: string };
type Person = { id: string; agentId?: string; agentType?: 'user' | 'public_profile_proxy'; a2aEligible?: boolean; a2aReasons?: string[]; name: string; role: string; bio: string; tags: string[]; reason: string; topic: string; greeting: string; url?: string; source?: 'zhihu' | 'demo' };
type Post = { id: string; person: string; kind: '发布' | '分享' | '赞同'; time: string; title: string; text: string; full: string; likes: number; author?: string; tags?: string[]; url?: string; source?: 'zhihu' | 'demo' };
type Run = { id: string; skill: Skill; createdAt: number; status: 'running' | 'completed' | 'failed'; stage: number; timeline: { text: string; kind: 'agent' | 'user' }[]; matches: string[]; contentMatches: string[]; people: Record<string, Person>; posts: Record<string, Post>; llmReady?: boolean; llmError?: string; searchError?: boolean };
type TriggeredRun = Run & { ownerId: string; profileSnapshot: AgentContextSnapshot };
type ProfileSynthesis = { titles: string[]; impressions: string[]; usedPublicFacts: boolean; provider: 'deepseek' | 'fallback' };

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
const port = Number(process.env.PORT || 3000);
const a2aBaseUrl = (process.env.A2A_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
const a2aSharedSecret = process.env.A2A_SHARED_SECRET || '';
const a2aStateStore = new A2AStateStore(join(dataDir, 'a2a-state.json'));
type A2ADelivery = { messageId: string; taskId: string; agentId: string; draft: A2ATurnDraft; createdAt: string };
const a2aDeliveries = new Map<string, A2ADelivery>();
const a2aRunning = new Set<string>();
const publicA2AAgents = new Map<string, Person>();

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
const f05DraftPort = new InMemoryF05InvitationDraftPort();

function fresh(): AppState { return { agentId: `agent:${randomUUID()}`, version: 1, step: 'auth', name: '', impressions: [], skills: [], following: [], feedIds: [], liked: [], saved: [], chats: {}, runs: [], discoverIds: [], contentIds: [], lastView: 'discover', people: {}, posts: {}, agentChats: {} }; }
function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); }
class RequestBodyTooLarge extends Error {}
async function body(req: IncomingMessage, maxBytes = Infinity) { let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > maxBytes) throw new RequestBodyTooLarge(); } return raw ? JSON.parse(raw) : {}; }
function sessionId(req: IncomingMessage, res: ServerResponse) { const cached = requestSessions.get(req); if (cached) return cached; const cookie = String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('z1space_session=')); const supplied = cookie ? decodeURIComponent(cookie.slice('z1space_session='.length)) : ''; const id = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplied) ? supplied : randomUUID(); requestSessions.set(req, id); if (id !== supplied) res.setHeader('set-cookie', `z1space_session=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Strict`); return id; }
async function saveSessions() { await mkdir(dataDir, { recursive: true }); await writeFile(stateFile, JSON.stringify(Object.fromEntries(sessions), null, 2)); }
function clearAllSessionCookies(res: ServerResponse) { res.setHeader('set-cookie', ['z1_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', 'z1space_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0']); }
async function deleteZ1SpaceAccount(req: IncomingMessage, res: ServerResponse) {
  const spaceSessionId = sessionId(req, res);
  const authSessionId = readCookie(req, 'z1_session');
  const userId = authSessionId ? authSessions.get(authSessionId)?.user?.id : undefined;
  const deletedSessionIds = new Set([spaceSessionId]);
  if (userId) {
    for (const [id, state] of sessions) if (state.zhihuUser?.id === userId) deletedSessionIds.add(id);
  }
  for (const id of deletedSessionIds) sessions.delete(id);
  for (const [id, run] of runs) if (deletedSessionIds.has(run.ownerId)) runs.delete(id);
  for (const key of recommendationSnapshots.keys()) if ([...deletedSessionIds].some(id => key.startsWith(`${id}:`))) recommendationSnapshots.delete(key);
  for (const session of [...a2aSessions.values()]) if (deletedSessionIds.has(session.requesterId)) removeA2ASession(session.id);
  await humanChatStore.deleteForUsers([...deletedSessionIds].flatMap(id => [`${id}:a`, `${id}:b`]));
  await saveSessions();
  if (authSessionId) authSessions.delete(authSessionId);
  clearAllSessionCookies(res);
  return json(res, 200, { ok: true });
}
function boundedProfileImpression(prefix: string, value: string, fallback: string) {
  const text = `${prefix}${value || fallback}`.trim();
  return text.length <= 420 ? text : `${text.slice(0, 419)}…`;
}
function registerDynamicPerson(person: Person) {
  if (!person.agentId) person.agentId = `agent:public:${person.id}`;
  if (!person.agentType) person.agentType = 'public_profile_proxy';
  publicA2AAgents.set(person.agentId, { ...person });
  candidateProfileProvider.setProfile(person.id, buildAgentContextSnapshot({
    profileVersion: 1,
    profileConfirmedAt: new Date().toISOString(),
    impressions: [
      boundedProfileImpression(`${person.name}的公开身份与实践方向：`, person.role, '知乎公开用户。'),
      boundedProfileImpression(`${person.name}的公开介绍：`, person.bio, '在知乎分享公开内容。'),
      boundedProfileImpression(`${person.name}在知乎公开讨论：`, person.topic, '知乎公开话题。')
    ],
    profileSourceReferences: [[person.url || `candidate:${person.id}:role`], [person.url || `candidate:${person.id}:bio`], [person.url || `candidate:${person.id}:topic`]],
    profilePublicBoundaries: ['public', 'public', 'public']
  }, person.id));
}
function hydrateStateEntities(state: AppState) {
  for (const person of Object.values(state.people || {})) {
    if (person && typeof person.id === 'string' && typeof person.name === 'string') registerDynamicPerson(person);
  }
}
function registerConfirmedAgent(state: AppState) {
  if (!state.agentId) return;
  const profile = snapshotFor(state, state.agentId);
  if (!profile?.confirmedAt) return;
  const publicSections = profile.sections.filter(section => section.publicBoundary === 'public');
  const person: Person = {
    id: state.agentId,
    agentId: state.agentId,
    agentType: 'user',
    name: state.name || 'Z1Space 用户',
    role: 'Z1Space 用户 Agent',
    bio: publicSections.map(section => section.impression).join(' ').slice(0, 420),
    tags: [],
    reason: '来自该用户本人确认的公开画像。',
    topic: publicSections.at(-1)?.impression || '围绕公开画像继续交流。',
    greeting: '你好，我是这个用户确认的 Agent。可以基于公开画像先交流。'
  };
  publicA2AAgents.set(state.agentId, person);
  candidateProfileProvider.setProfile(state.agentId, profile);
}
async function loadSessions() { if (!existsSync(stateFile)) return; try { const saved = JSON.parse(await readFile(stateFile, 'utf8')); for (const [id, value] of Object.entries(saved)) { const state = value as AppState; sessions.set(id, state); hydrateStateEntities(state); registerConfirmedAgent(state); } } catch { /* a corrupt demo file should not block a fresh session */ } }
function currentState(req: IncomingMessage, res: ServerResponse) { const id = sessionId(req, res); if (!sessions.has(id)) sessions.set(id, fresh()); const state = sessions.get(id)!; if (!state.agentId) state.agentId = `agent:${randomUUID()}`; return state; }
function hasValidImpressions(state: AppState) { return Array.isArray(state.impressions) && state.impressions.length === 3 && state.impressions.every(value => typeof value === 'string' && value.trim().length >= 8); }
function backfillProfileConfirmation(state: AppState) {
  if (state.profileConfirmedAt || !['skills', 'done'].includes(state.step) || !hasValidImpressions(state)) return false;
  state.profileVersion = Number.isInteger(state.profileVersion) && Number(state.profileVersion) > 0 ? Number(state.profileVersion) : 1;
  state.profileConfirmedAt = new Date().toISOString();
  return true;
}
function stateCompleteness(state: AppState) {
  const stepRank = { auth: 0, impressions: 1, skills: 2, done: 3 } as Record<string, number>;
  return (stepRank[state.step] || 0) * 10 + (Array.isArray(state.impressions) ? Math.min(state.impressions.length, 3) : 0);
}
function restoreStateForAuthenticatedUser(req: IncomingMessage, res: ServerResponse) {
  const userId = authSession(req).user?.id;
  if (!userId) return currentState(req, res);
  const id = sessionId(req, res);
  const current = currentState(req, res);
  if (current.zhihuUser?.id === userId) { clearSeededDiscovery(current); return current; }
  const saved = [...sessions.values()]
    .filter(state => state.zhihuUser?.id === userId)
    .sort((left, right) => (Number(right.updatedAt || 0) - Number(left.updatedAt || 0)) || (stateCompleteness(right) - stateCompleteness(left)))[0];
  if (!saved) {
    if (current.zhihuUser?.id && current.zhihuUser.id !== userId) {
      const next = fresh();
      sessions.set(id, next);
      void saveSessions();
      return next;
    }
    return current;
  }
  const restored = { ...fresh(), ...saved };
  backfillProfileConfirmation(restored);
  sessions.set(id, restored);
  hydrateStateEntities(restored);
  clearSeededDiscovery(restored);
  void saveSessions();
  return restored;
}
function authSession(req: IncomingMessage) { return authSessions.getOrCreate(req); }
function secureCookies(req: IncomingMessage) { return req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production'; }
function authError(res: ServerResponse, message: string) { return redirect(res, `/?auth=error&reason=${encodeURIComponent(message)}`); }
function humanUser(req: IncomingMessage, url: URL, res: ServerResponse): HumanUser {
  const selected = String(req.headers['x-z1-demo-user'] || url.searchParams.get('demoUser') || 'a').toLowerCase() === 'b' ? 'b' : 'a';
  return { id: `${sessionId(req, res)}:${selected}`, name: selected === 'b' ? '演示用户 B' : '演示用户 A' };
}
function profileDescription(skill: Skill) { const goal = String(skill.goal || '').trim().replace(/[。.!！?？]+$/, ''); return goal ? `正在通过 Agent：${goal}，并把这轮探索中形成的连接沉淀为个人画像。` : `正在使用「${skill.name}」探索值得认识的人与信息。`; }
function publicProfileQuery(profile: AgentContextSnapshot) { return profile.sections.filter(section => section.publicBoundary === 'public').map(section => section.impression.trim()).filter(Boolean).join(' ').trim(); }
function discoveryQuery(profile: AgentContextSnapshot) {
  return publicProfileQuery(profile).slice(0, 360);
}
function runFor(skill: Skill): Run { return { id: randomUUID(), skill, createdAt: Date.now(), status: 'running', stage: 0, timeline: [{ kind: 'agent', text: `收到，我开始执行「${skill.name}」。我会先结合你确认的公开用户画像，再在知乎寻找有依据的用户连接。` }], matches: [], contentMatches: [], people: {}, posts: {}, llmReady: false }; }
function triggeredRun(skill: Skill, ownerId: string, profileSnapshot: AgentContextSnapshot): TriggeredRun { return { ...runFor(skill), ownerId, profileSnapshot }; }
function publicRun(run: TriggeredRun) {
  const { ownerId: _ownerId, profileSnapshot: _profileSnapshot, ...value } = run;
  const discoveryIntent = extractSkillDiscoveryIntent(run);
  const peopleForClient = Object.fromEntries(Object.entries(run.people).map(([id, person]) => [id, { ...person, ...(person.a2aEligible === undefined ? {} : { a2aEligible: person.a2aEligible, a2aReasons: person.a2aReasons || [] }) }]));
  return { ...value, people: peopleForClient, profileVersion: run.profileSnapshot.profileVersion, ...(discoveryIntent ? { discoveryIntent } : {}) };
}
function attachRunA2AEligibility(run: TriggeredRun) {
  const query = skillDiscoveryQuery(run.skill);
  for (const person of Object.values(run.people)) {
    const candidate: PeopleCandidate = { id: person.id, name: person.name, role: person.role, bio: person.bio, tags: person.tags, topic: person.topic };
    const recommendation = recallPeople([candidate], [query, person.topic, person.name].filter(Boolean).join(' ').slice(0, 360), run.profileSnapshot, 1).recommendations[0];
    person.a2aEligible = Boolean(recommendation?.a2aEligible);
    person.a2aReasons = [...(recommendation?.a2aReasons || ['MATCH_NOT_STRONG_ENOUGH'])];
  }
}
function clearSeededDiscovery(state: AppState) {
  state.discoverIds = (state.discoverIds || []).filter(id => !['chen', 'xia', 'zhou'].includes(id));
  state.contentIds = (state.contentIds || []).filter(id => !['p1', 'p3', 'p5'].includes(id));
  state.feedIds = (state.feedIds || []).filter(id => !['chen', 'xia', 'zhou'].includes(id));
}
function mergeRunDiscoveryIntoState(state: AppState, run: Run) {
  state.people = { ...(state.people || {}), ...run.people };
  state.posts = { ...(state.posts || {}), ...run.posts };
  state.discoverIds = [...new Set([...(state.discoverIds || []), ...run.matches])];
  state.contentIds = [...new Set([...(state.contentIds || []), ...run.contentMatches])];
  state.feedIds = [...new Set([...(state.feedIds || []), ...run.matches])];
  for (const person of Object.values(run.people)) registerDynamicPerson(person);
}
function postCandidate(post: Post): ContentCandidate { return { id: post.id, title: post.title, excerpt: post.text, tags: post.tags || [], authorId: post.person }; }
function peopleForState(state: AppState, run?: Run) { return { ...people, ...(state.people || {}), ...(run?.people || {}) }; }
function postsForState(state: AppState, run?: Run) { return { ...(state.posts || {}), ...(run?.posts || {}) }; }
function trigger(type: TriggerEvent['type'], ownerId: string, payload: Record<string, unknown>, source: TriggerEvent['source'] = 'web'): TriggerEvent { const eventId = randomUUID(); return { schemaVersion: 1, eventId, type, occurredAt: new Date().toISOString(), source, actor: { userId: ownerId, sessionId: ownerId }, correlationId: eventId, payload }; }
function snapshotFor(state: AppState, ownerId: string) { try { return buildAgentContextSnapshot(state, ownerId); } catch { return null; } }
function routeError(res: ServerResponse, plan: { accepted: false; code: string }) { const status = plan.code === 'PROFILE_NOT_CONFIRMED' || plan.code === 'SKILL_DISABLED' ? 409 : 400; return json(res, status, { error: plan.code }); }
function recommendationKey(ownerId: string, recommendationId: string) { return `${ownerId}:${recommendationId}`; }
function saveRecommendationSnapshots(ownerId: string, query: string, profileVersion: number, recommendations: readonly Recommendation[]) { return recommendations.map(recommendation => { const stored = Object.freeze({ ...recommendation, id: randomUUID() }); recommendationSnapshots.set(recommendationKey(ownerId, stored.id), Object.freeze({ recommendationId: stored.id, ownerId, candidateId: stored.targetId, targetType: stored.targetType, query, profileVersion, verdict: stored.verdict, a2aEligible: stored.a2aEligible, a2aReasons: Object.freeze([...stored.a2aReasons]), evidenceRefs: Object.freeze([...stored.evidenceRefs]), createdAt: new Date().toISOString() })); const ownerPrefix = `${ownerId}:`; while ([...recommendationSnapshots.keys()].filter(key => key.startsWith(ownerPrefix)).length > maxRecommendationSnapshotsPerOwner) recommendationSnapshots.delete([...recommendationSnapshots.keys()].find(key => key.startsWith(ownerPrefix))!); return stored.targetType === 'person' && stored.a2aEligible ? Object.freeze({ ...stored, a2aSessionEndpoint: '/api/a2a-sessions' as const }) : stored; }); }
function removeA2ASession(sessionId: string) { a2aSessions.delete(sessionId); for (const [key, value] of a2aIdempotency) if (value === sessionId) a2aIdempotency.delete(key); }
function pruneA2ASessions(ownerId: string) { const terminal = (session: A2ASession) => session.status === 'completed' || session.status === 'failed'; while ([...a2aSessions.values()].filter(session => session.requesterId === ownerId).length >= maxA2ASessionsPerOwner) { const oldest = [...a2aSessions.values()].find(session => session.requesterId === ownerId && terminal(session)); if (!oldest) break; removeA2ASession(oldest.id); } while (a2aSessions.size >= maxA2ASessions) { const oldest = [...a2aSessions.values()].find(terminal); if (!oldest) break; removeA2ASession(oldest.id); } }
function hasA2ACapacity(ownerId: string) { const sessions = [...a2aSessions.values()]; const active = sessions.filter(session => session.status === 'created' || session.status === 'running' || session.status === 'observing'); return active.length < maxConcurrentA2ASessions && active.filter(session => session.requesterId === ownerId).length < maxConcurrentA2ASessionsPerOwner && sessions.length < maxA2ASessions && sessions.filter(session => session.requesterId === ownerId).length < maxA2ASessionsPerOwner; }

function persistedSkillForRun(state: AppState, runId: string | undefined) {
  const records = Array.isArray(state.runs) ? state.runs.filter(value => objectValue(value)) : [];
  const record = runId ? records.find(value => objectValue(value)?.id === runId) : records.at(-1);
  const skillId = objectValue(record)?.skillId;
  return typeof skillId === 'string' ? state.skills.find(skill => skill.id === skillId) : undefined;
}
function resolveCandidateRecommendation(ownerId: string, state: AppState, profile: AgentContextSnapshot, runId: string | undefined, candidateId: string) {
  const run = runId ? runs.get(runId) : undefined;
  if (run && run.ownerId !== ownerId) return { error: 'CANDIDATE_NOT_FOUND' as const };
  if (run && advance(run).status !== 'completed') return { error: 'RUN_NOT_COMPLETED' as const };
  const candidate = run?.people[candidateId] || peopleForState(state)[candidateId];
  const belongsToRun = Boolean(run?.matches.includes(candidateId));
  const belongsToState = Boolean(state.discoverIds?.includes(candidateId) || state.people?.[candidateId]);
  if (!candidate || (!belongsToRun && !belongsToState)) return { error: 'CANDIDATE_NOT_FOUND' as const };
  registerDynamicPerson(candidate);
  const skill = run?.skill || persistedSkillForRun(state, runId);
  const query = [skill ? skillDiscoveryQuery(skill) : '', candidate.topic || '', candidate.name].filter(Boolean).join(' ').slice(0, 360);
  const result = recallPeople([candidate], query, profile, 1);
  const recommendation = result.recommendations[0];
  if (!recommendation) return { error: 'CANDIDATE_NOT_FOUND' as const };
  const stored = saveRecommendationSnapshots(ownerId, query, profile.profileVersion, [recommendation])[0];
  return stored ? { recommendation: recommendationSnapshots.get(recommendationKey(ownerId, stored.id))! } : { error: 'CANDIDATE_NOT_FOUND' as const };
}

async function persistA2AState() {
  const value: A2AStoredState = {
    sessions: Object.fromEntries(a2aSessions),
    idempotency: Object.fromEntries(a2aIdempotency),
    deliveries: Object.fromEntries(a2aDeliveries)
  };
  await a2aStateStore.save(value);
}
async function loadA2AState() {
  const saved = await a2aStateStore.load();
  if (!saved) return;
  for (const [id, value] of Object.entries(saved.sessions || {})) if (value && typeof value === 'object') a2aSessions.set(id, value as A2ASession);
  for (const [key, value] of Object.entries(saved.idempotency || {})) if (typeof value === 'string') a2aIdempotency.set(key, value);
  for (const [key, value] of Object.entries(saved.deliveries || {})) if (value && typeof value === 'object') a2aDeliveries.set(key, value as A2ADelivery);
}
function a2aAgentIdFor(session: A2ASession, speaker: 'requester_agent' | 'candidate_agent') { return speaker === 'requester_agent' ? (session.requesterAgentId || session.requesterId) : (session.candidateAgentId || session.candidateId); }
function a2aAgentCardBaseUrl() { return process.env.A2A_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || a2aBaseUrl; }
function validA2ASecret(req: IncomingMessage) {
  if (!a2aSharedSecret) return true;
  const value = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = Buffer.from(a2aSharedSecret); const actual = Buffer.from(value);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function a2aJsonRpcError(res: ServerResponse, id: unknown, status: number, code: number, message: string) { return json(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }); }
function a2aTaskView(session: A2ASession) {
  const state = session.status === 'completed' ? 'completed' : session.status === 'failed' ? 'failed' : 'working';
  return { id: session.id, contextId: session.id, status: { state, ...(session.failureCode ? { message: { role: 'ROLE_AGENT', parts: [{ text: session.failureCode }] } } : {}) }, history: session.turns.map(turn => ({ messageId: turn.id, role: 'ROLE_AGENT', parts: [{ text: turn.text }], metadata: { speaker: turn.speaker, round: turn.round } })), metadata: { requesterAgentId: a2aAgentIdFor(session, 'requester_agent'), candidateAgentId: a2aAgentIdFor(session, 'candidate_agent'), transport: 'http-jsonrpc' } };
}
function a2aTurnResponse(id: unknown, taskId: string, agentId: string, messageId: string, draft: A2ATurnDraft) { return { jsonrpc: '2.0', id: id ?? null, result: { message: { messageId, role: 'ROLE_AGENT', taskId, contextId: taskId, parts: [{ text: draft.text }], metadata: { agentId, z1spaceTurn: draft } } } }; }

const deepseekBaseUrl = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
async function deepseekChat(messages: { role: 'system' | 'user' | 'assistant'; content: string }[], options: Record<string, unknown> = {}) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  const response = await fetch(`${deepseekBaseUrl}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: deepseekModel, messages, temperature: 0.4, ...options }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const payload = await response.json() as { choices?: { message?: { content?: string } }[] };
  return payload.choices?.[0]?.message?.content?.trim() || '';
}
function synthesisText(value: unknown, limit: number) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit); }
function a2aTurnIntent(round: A2ATurnRequest['round']): A2ATurnDraft['intent'] {
  return round === 1 ? 'position' : round === 2 ? 'response' : 'summary';
}
function a2aFallbackTurn(request: A2ATurnRequest): A2ATurnDraft {
  const owner = request.agentRole;
  const evidence = request.evidenceLedger.entries.find(item => item.owner === owner);
  const previous = request.previousTurns.at(-1);
  const phase = request.round === 1 ? '陈述与议题相关的经历' : request.round === 2 ? '回应另一位 Agent 的观点' : '总结共识、分歧和下一步';
  const previousContext = previous ? `上一位 Agent 提到：“${previous.text.slice(0, 100)}”` : '这是本次 A2A 交流的开场。';
  const text = `${owner === 'requester' ? '发起方 Agent' : '候选方 Agent'}：${phase}。${evidence ? evidence.excerpt : '当前没有足够的公开证据支持事实陈述。'} ${previousContext}`.trim();
  return {
    intent: a2aTurnIntent(request.round),
    text,
    claims: evidence ? [{ text: evidence.excerpt, evidenceRefIds: [evidence.id] }] : [],
    questions: request.round === 2 ? [`你如何看待「${request.topic}」中的具体取舍？`] : []
  };
}
function a2aFallbackObservation(request: A2AObserverRequest): A2AObservationDraft {
  const evidenceRefs = ['requester', 'candidate'].map(owner => request.evidenceLedger.entries.find(item => item.owner === owner)?.id).filter((id): id is string => !!id);
  return {
    verdict: 'proceed',
    reason: '双方 Agent 都基于各自公开证据完成了双向交流，适合由用户决定是否继续认识。',
    reasonCodes: ['MUTUAL_TOPIC_ALIGNMENT', 'COMPLEMENTARY_EXPERIENCE'],
    evidenceRefs,
    suggestedTopic: request.topic,
    suggestedOpening: `想继续聊聊「${request.topic}」中双方提到的具体经历。`
  };
}
function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function parseA2ATurn(content: string, request: A2ATurnRequest): A2ATurnDraft | null {
  try {
    const parsed = objectValue(JSON.parse(content));
    const text = typeof parsed?.text === 'string' ? parsed.text.trim() : '';
    const allowed = new Set(request.evidenceLedger.entries.filter(item => item.owner === request.agentRole).map(item => item.id));
    const claims = Array.isArray(parsed?.claims) ? parsed.claims.map(value => {
      const claim = objectValue(value);
      const claimText = typeof claim?.text === 'string' ? claim.text.trim() : '';
      const refs = Array.isArray(claim?.evidenceRefIds) ? claim.evidenceRefIds.filter((id): id is string => typeof id === 'string' && allowed.has(id)) : [];
      return claimText && refs.length ? { text: claimText, evidenceRefIds: refs } : null;
    }).filter((claim): claim is { text: string; evidenceRefIds: string[] } => !!claim) : [];
    const questions = Array.isArray(parsed?.questions) ? parsed.questions.filter((question): question is string => typeof question === 'string' && question.trim()).map(question => question.trim()).slice(0, 3) : [];
    if (!text || !claims.length || (request.round === 2 && !questions.length)) return null;
    return { intent: a2aTurnIntent(request.round), text, claims, questions: request.round === 2 ? questions : [] };
  } catch { return null; }
}
async function generateModelA2ATurn(request: A2ATurnRequest): Promise<A2ATurnDraft | null> {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  const evidence = request.evidenceLedger.entries.filter(item => item.owner === request.agentRole).map(item => ({ id: item.id, excerpt: item.excerpt, sourceReferences: item.sourceReferences }));
  const previousTurns = request.previousTurns.slice(-8).map(turn => ({ speaker: turn.speaker, round: turn.round, text: turn.text }));
  try {
    const content = await deepseekChat([
      { role: 'system', content: `你是 Z1Space 的${request.agentRole === 'requester' ? '发起方' : '候选方'}个人 Agent，正在通过 A2A 与另一位用户的 Agent 进行预交流。你只能基于自己的公开证据回答，不得冒充真人，不得补充证据之外的经历。必须回应对话历史，让交流产生增量。只输出 JSON：{"text":"...","claims":[{"text":"...","evidenceRefIds":["允许的证据ID"]}],"questions":["..."]}。第 ${request.round} 轮的目标是${request.round === 1 ? '陈述相关经历' : request.round === 2 ? '回应对方并提出一个可继续的问题' : '总结共识、分歧和信息增量'}。允许引用的证据 ID：${evidence.map(item => item.id).join(', ')}` },
      { role: 'user', content: JSON.stringify({ agentId: request.agentId, topic: request.topic, ownEvidence: evidence, previousTurns }) }
    ], { response_format: { type: 'json_object' }, max_tokens: 600 });
    return content ? parseA2ATurn(content, request) : null;
  } catch { return null; }
}
function parseA2AObservation(content: string, request: A2AObserverRequest): A2AObservationDraft | null {
  try {
    const parsed = objectValue(JSON.parse(content));
    const verdict = parsed?.verdict;
    if (verdict !== 'proceed' && verdict !== 'needs_user_review' && verdict !== 'stop') return null;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    const reasonCodes = Array.isArray(parsed.reasonCodes) ? parsed.reasonCodes.filter((code): code is A2AObservationDraft['reasonCodes'][number] => typeof code === 'string' && ['MUTUAL_TOPIC_ALIGNMENT', 'COMPLEMENTARY_EXPERIENCE', 'EXPLORABLE_DIVERGENCE', 'ACTIONABLE_NEXT_QUESTION', 'ONE_SIDED_EVIDENCE', 'INSUFFICIENT_EVIDENCE', 'CONTRADICTORY_EVIDENCE', 'NO_CLEAR_EXCHANGE_VALUE'].includes(code)) : [];
    const allowed = new Set(request.evidenceLedger.entries.map(item => item.id));
    const evidenceRefs = Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs.filter((id): id is string => typeof id === 'string' && allowed.has(id)) : [];
    const cited = new Set(request.turns.flatMap(turn => turn.claims.flatMap(claim => claim.evidenceRefIds)));
    const citedRefs = evidenceRefs.filter(id => cited.has(id));
    const owners = new Set(citedRefs.map(id => request.evidenceLedger.entries.find(item => item.id === id)?.owner));
    const suggestedTopic = typeof parsed.suggestedTopic === 'string' ? parsed.suggestedTopic.trim() : undefined;
    const suggestedOpening = typeof parsed.suggestedOpening === 'string' ? parsed.suggestedOpening.trim() : undefined;
    if (!reason || !reasonCodes.length || !citedRefs.length) return null;
    if (verdict !== 'stop' && (reasonCodes.includes('INSUFFICIENT_EVIDENCE') || reasonCodes.includes('NO_CLEAR_EXCHANGE_VALUE') || !owners.has('requester') || !owners.has('candidate'))) return null;
    return { verdict, reason, reasonCodes, evidenceRefs: citedRefs, ...(suggestedTopic ? { suggestedTopic } : {}), ...(suggestedOpening ? { suggestedOpening } : {}) };
  } catch { return null; }
}
async function generateModelA2AObservation(request: A2AObserverRequest): Promise<A2AObservationDraft | null> {
  if (!process.env.DEEPSEEK_API_KEY) return null;
  try {
    const content = await deepseekChat([
      { role: 'system', content: '你是 Z1Space 的 A2A Observer。只根据双方 Agent 的公开证据和完整 transcript 判断是否值得把连接交回用户。只输出 JSON：{"verdict":"proceed|needs_user_review|stop","reason":"...","reasonCodes":["..."],"evidenceRefs":["已引用的证据ID"],"suggestedTopic":"...","suggestedOpening":"..."}。proceed 或 needs_user_review 必须引用双方已在 claims 中引用的证据。' },
      { role: 'user', content: JSON.stringify({ topic: request.topic, evidenceLedger: request.evidenceLedger.entries, turns: request.turns }) }
    ], { response_format: { type: 'json_object' }, max_tokens: 500 });
    return content ? parseA2AObservation(content, request) : null;
  } catch { return null; }
}
const localA2AAdapter = new TransportA2ASessionAdapter({
  async sendTurn(request) { return await generateModelA2ATurn(request) || a2aFallbackTurn(request); },
  async observe(request) { return await generateModelA2AObservation(request) || a2aFallbackObservation(request); }
});
const a2aAdapter = new TransportA2ASessionAdapter(new HttpA2AAgentTransport({
  baseUrl: a2aBaseUrl,
  ...(a2aSharedSecret ? { sharedSecret: a2aSharedSecret } : {}),
  observe: request => localA2AAdapter.observe(request)
}));
function startA2ASession(session: A2ASession) {
  if (a2aRunning.has(session.id) || ['completed', 'failed'].includes(session.status)) return;
  a2aRunning.add(session.id);
  void runA2ASession(session, a2aAdapter, f05DraftPort, async updated => {
    if (!a2aSessions.has(updated.id)) return;
    a2aSessions.set(updated.id, updated);
    await persistA2AState();
  }).catch(error => console.error('A2A session runner failed:', error instanceof Error ? error.message : error)).finally(() => a2aRunning.delete(session.id));
}
function profileAnswerText(value: string) { return synthesisText(value, 420).replace(/[。！？!?]+$/, ''); }
function profileAnswerCore(value: string) {
  const original = profileAnswerText(value);
  let text = original;
  const prefix = /^(我想|我正在|我希望|我更看重|我通常会|我会|是否有|如果|关于|对于|在)/;
  while (prefix.test(text)) text = text.replace(prefix, '').trim();
  return text || original;
}
function profileTitleFromAnswer(answer: string, index: number) {
  return (profileAnswerCore(answer) || `回答 ${index + 1}`).slice(0, 18);
}
function fallbackProfileSynthesis(answers: string[], publicFacts: string[]): ProfileSynthesis {
  const cores = answers.map(profileAnswerCore);
  const impressions = [
    `你正在投入：${cores[0]}。`,
    `面对想法与行动，${cores[1]}是你在意的判断。`,
    `在新的连接中，你期待：${cores[2]}。`
  ];
  if (publicFacts[0]) impressions[0] = `${impressions[0]} 公开资料里还提到：${profileAnswerText(publicFacts[0])}。`;
  return { titles: answers.map(profileTitleFromAnswer), impressions: impressions.map(value => synthesisText(value, 400)), usedPublicFacts: publicFacts.length > 0, provider: 'fallback' };
}
function parseProfileSynthesis(content: string, usedPublicFacts: boolean): ProfileSynthesis | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { titles?: unknown; impressions?: unknown };
    const titles = Array.isArray(parsed.titles) ? parsed.titles.map(value => synthesisText(value, 24)) : [];
    const impressions = Array.isArray(parsed.impressions) ? parsed.impressions.map(value => synthesisText(value, 400)) : [];
    const forbidden = /暂无|未提供|未读取|资料不足|不(会)?臆测|不清楚|不知道/;
    if (titles.length !== 3 || impressions.length !== 3 || [...titles, ...impressions].some(value => !value || forbidden.test(value))) return null;
    return { titles, impressions, usedPublicFacts, provider: 'deepseek' };
  } catch { return null; }
}
function profilePublicFacts(req: IncomingMessage) {
  const session = authSession(req);
  const user = session.user;
  const userData = session.userData;
  const headline = synthesisText(user?.headline, 160);
  const description = synthesisText(user?.description, 240);
  const titles = (userData?.contentItems || []).map(item => synthesisText(item.title, 120)).filter(Boolean).slice(0, 3);
  return [
    ...(headline ? [`公开介绍：${headline}`] : []),
    ...(description && description !== headline ? [`公开简介：${description}`] : []),
    ...titles.map(title => `公开表达标题：${title}`)
  ];
}
async function synthesizeProfile(answers: string[], publicFacts: string[]): Promise<ProfileSynthesis> {
  const fallback = fallbackProfileSynthesis(answers, publicFacts);
  try {
    const content = await deepseekChat([
      { role: 'system', content: '你是 Z1Space 的用户画像编辑器。只能基于输入中的三次回答和明确给出的公开资料事实生成中文画像，绝不补充外部信息。若公开资料事实为空，直接忽略这一维度；不要解释资料为空、没有、未读取、未提供或信息不足，也不要说不会臆测。不得把公开资料与回答强行说成相近。输出严格 JSON，不使用 Markdown，格式为 {"titles":["...","...","..."],"impressions":["...","...","..."]}。三个标题须为 4 到 14 个中文字符或短语，具体且互不重复；三段画像每段 45 到 110 字，语气克制、可编辑、只陈述可由输入支持的倾向。' },
      { role: 'user', content: JSON.stringify({ answers, publicFacts }) }
    ], { response_format: { type: 'json_object' }, temperature: 0.35 });
    return content ? parseProfileSynthesis(content, publicFacts.length > 0) || fallback : fallback;
  } catch { return fallback; }
}
async function enrichRun(run: TriggeredRun, state: AppState) {
  const query = skillDiscoveryQuery(run.skill);
  try {
    const search = await searchZhihu(query, 10);
    const tags = [...new Set(query.split(/[\s,，、]+/).map(value => value.trim()).filter(Boolean))].slice(0, 5);
    for (const result of search.users) {
      const id = zhihuAuthorId(result);
      if (!run.people[id]) run.people[id] = {
        id,
        name: result.authorName,
        role: '知乎用户 · 来自知乎搜索',
        bio: result.excerpt || `在知乎分享「${result.title}」相关经验。`,
        tags,
        reason: `知乎搜索中发现其分享过「${result.title}」，与“${query}”直接相关。`,
        topic: result.title,
        greeting: `你好，看到你在知乎分享「${result.title}」，我也在关注“${query}”，想了解你的实践经历。`,
        url: result.url,
        source: 'zhihu'
      };
      run.matches.push(...(run.matches.includes(id) ? [] : [id]));
    }
    for (const result of search.items) {
      const personId = zhihuAuthorId(result);
      const id = zhihuContentId(result);
      run.posts[id] = {
        id,
        person: personId,
        kind: '发布',
        time: '刚刚',
        title: result.title,
        text: result.excerpt || `知乎公开内容「${result.title}」`,
        full: result.excerpt || `知乎公开内容「${result.title}」`,
        likes: 0,
        author: result.authorName,
        url: result.url,
        source: 'zhihu'
      };
      if (!run.contentMatches.includes(id)) run.contentMatches.push(id);
    }
    for (const person of Object.values(run.people)) {
      try {
        registerDynamicPerson(person);
      } catch (error) {
        run.timeline.push({ kind: 'agent', text: `候选人「${person.name}」的公开资料格式异常，已保留搜索结果并跳过 Agent 画像注册。` });
        console.warn('Failed to register candidate profile:', error instanceof Error ? error.message : error);
      }
    }
    if (!search.items.length) run.timeline.push({ kind: 'agent', text: `知乎搜索暂未返回“${query}”对应的公开用户或内容结果。` });
  } catch (error) {
    run.searchError = true;
    run.llmError = error instanceof Error ? error.message : '知乎搜索失败';
    run.timeline.push({ kind: 'agent', text: '知乎 Skill 暂时无法完成真实搜索，请检查 CLI 认证或网络连接。' });
  }
  if (process.env.DEEPSEEK_API_KEY && run.matches.length) {
    try {
      const candidateList = run.matches.map(id => run.people[id]).filter(Boolean).map(p => ({ id: p.id, name: p.name, role: p.role, bio: p.bio, tags: p.tags, topic: p.topic }));
      const content = await deepseekChat([
        { role: 'system', content: '你是 Z1Space 的匹配 Agent。请基于用户确认的公开画像、Skill 补充线索和候选人的公开简介，给出可靠、克制、有行动价值的匹配结果。只输出 JSON，格式为 {"matches":[{"id":"候选人id","reason":"不超过80字的匹配理由","opening":"一个适合用户继续询问对方 Agent 的问题"}],"summary":"不超过80字的总结"}。不要编造候选人资料。' },
        { role: 'user', content: JSON.stringify({ profile: run.profileSnapshot.sections.filter(section => section.publicBoundary === 'public').map(section => section.impression), skill: run.skill, query, candidates: candidateList }) }
      ], { response_format: { type: 'json_object' }, max_tokens: 700 });
      const parsed = JSON.parse(content || '{}') as { matches?: { id: string; reason?: string; opening?: string }[]; summary?: string };
      const enriched = (parsed.matches || []).filter(x => run.people[x.id]);
      if (parsed.summary) run.timeline.push({ kind: 'agent', text: parsed.summary });
      for (const match of enriched) {
        if (match.reason && run.people[match.id]) run.people[match.id].reason = match.reason;
        if (match.opening && run.people[match.id]) {
          run.people[match.id].topic = match.opening;
          run.people[match.id].greeting = `你好，关于“${query}”，我想和你继续交流：${match.opening}`;
        }
      }
    } catch (error) {
      run.llmError = error instanceof Error ? error.message : 'DeepSeek request failed';
      run.timeline.push({ kind: 'agent', text: '模型暂时不可用，我先用知乎搜索结果继续。' });
    }
  }
  run.llmReady = true;
  attachRunA2AEligibility(run);
  mergeRunDiscoveryIntoState(state, run);
  await saveSessions();
}

function completionSummary(run: Run) {
  const peopleCount = run.matches.length;
  const contentCount = run.contentMatches.length;
  if (!peopleCount && !contentCount) return '这次没有找到符合条件的用户或相关内容。你可以调整 Skill 的目标或关键词后再试。';
  if (!peopleCount) return `这次没有找到符合条件的用户，但找到了 ${contentCount} 条相关内容。你可以先查看这些内容，再调整方向。`;
  if (!contentCount) return `找到了 ${peopleCount} 位可能有帮助的人，但暂未找到相关内容。你可以先与他们的 Agent 交流，再决定是否继续认识。`;
  return '有结果了。下面的人物和内容来自本次任务的匹配依据，你可以先与他们的 Agent 交流，再决定是否继续认识。';
}
function advance(run: Run) {
  const elapsed = Date.now() - run.createdAt;
  const stage = Math.min(run.llmReady ? 3 : 2, Math.floor(elapsed / 650));
  while (run.stage < stage) {
    run.stage += 1;
    if (run.stage === 1) run.timeline.push({ kind: 'agent', text: '我正在理解你的目标，并把需求拆成几个可匹配的线索，避免只按关键词机械搜索。' });
    if (run.stage === 2) run.timeline.push({ kind: 'agent', text: `我找到了 ${run.matches.length} 位可能有帮助的人和 ${run.contentMatches.length} 条相关内容，正在整理他们与你的共同话题。` });
    if (run.stage === 3) {
      run.status = run.searchError ? 'failed' : 'completed';
      if (!run.searchError) run.timeline.push({ kind: 'agent', text: completionSummary(run) });
    }
  }
  return run;
}
function staticPath(pathname: string) { if (pathname === '/') return join(root, 'Z1Space.html'); if (pathname === '/z1space-client.js') return join(root, 'public', 'z1space-client.js'); if (pathname === '/assets/z1space-icon.png') return join(root, 'public', 'assets', 'z1space-icon.png'); return null; }

async function directA2AReply(agent: Person, prompt: string) {
  const fallback = `${agent.name} 的 Agent：我会基于公开画像回应。${agent.bio.slice(0, 180)} 你想先从哪段具体经历聊起？`;
  try {
    return await deepseekChat([{ role: 'system', content: `你是 ${agent.name} 的用户 Agent，只能根据这份已公开画像回答，不要冒充真人，不要补充画像之外的事实，控制在180字内：${JSON.stringify(agent)}` }, { role: 'user', content: prompt }]) || fallback;
  } catch { return fallback; }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,Authorization,A2A-Version,X-Z1-Session' }); return res.end(); }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'z1space-api', a2a: 'http-jsonrpc' });
    if (url.pathname === '/.well-known/agent-card.json' && req.method === 'GET') return json(res, 200, a2aAgentCard(a2aAgentCardBaseUrl(), 'z1space-gateway', 'Z1Space A2A Gateway', '为已确认画像的用户 Agent 提供受控的 A2A 预交流入口。', 'gateway'));
    if (url.pathname === '/api/agents/me/card' && req.method === 'GET') {
      const state = currentState(req, res);
      registerConfirmedAgent(state);
      const profile = snapshotFor(state, state.agentId || sessionId(req, res));
      if (!profile || !profile.confirmedAt) return json(res, 409, { error: 'PROFILE_NOT_CONFIRMED' });
      return json(res, 200, a2aAgentCard(a2aAgentCardBaseUrl(), state.agentId!, state.name || 'Z1Space 用户 Agent', '只基于本人确认并标记为公开的画像内容进行 A2A 交流。', 'user'));
    }
    const cardMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/card$/);
    if (cardMatch && req.method === 'GET') {
      const agentId = decodeURIComponent(cardMatch[1]);
      const publicAgent = publicA2AAgents.get(agentId);
      if (publicAgent) return json(res, 200, a2aAgentCard(a2aAgentCardBaseUrl(), agentId, `${publicAgent.name} 的公开资料代理`, '仅基于知乎公开资料生成回复；这不是该用户本人已授权的独立 Agent。', 'public_profile_proxy'));
      return json(res, 404, { error: 'AGENT_NOT_FOUND' });
    }
    const gatewayPath = url.pathname.match(/^\/a2a(?:\/agents\/([^/]+))?$/);
    if (gatewayPath && req.method === 'POST') {
      if (!validA2ASecret(req)) { res.setHeader('www-authenticate', 'Bearer'); return a2aJsonRpcError(res, null, 401, -32001, 'A2A_UNAUTHORIZED'); }
      const input = await body(req, 16_384) as { id?: unknown; method?: unknown; params?: unknown };
      const rpcId = input.id ?? null;
      if (input.method !== 'SendMessage' && input.method !== 'message/send') return a2aJsonRpcError(res, rpcId, 400, -32601, 'A2A_METHOD_NOT_SUPPORTED');
      const params = objectValue(input.params);
      const message = objectValue(params?.message);
      const metadata = objectValue(message?.metadata) || objectValue(params?.metadata);
      const z1 = objectValue(metadata?.z1space);
      const targetAgentId = decodeURIComponent(gatewayPath[1] || String(params?.targetAgentId || z1?.agentId || ''));
      const taskId = String(message?.taskId || params?.taskId || '');
      const session = a2aSessions.get(taskId);
      if (!targetAgentId) return a2aJsonRpcError(res, rpcId, 404, -32004, 'A2A_AGENT_NOT_FOUND');
      if (!session) {
        const agent = publicA2AAgents.get(targetAgentId);
        const prompt = Array.isArray(message?.parts) ? message.parts.map(part => objectValue(part)?.text).filter((text): text is string => typeof text === 'string').join(' ').trim() : '';
        if (!agent || !prompt) return a2aJsonRpcError(res, rpcId, 404, -32004, 'A2A_AGENT_NOT_FOUND');
        const messageId = String(message?.messageId || `a2a:${targetAgentId}:${randomUUID()}`);
        const deliveryKey = `direct:${targetAgentId}:${messageId}`;
        const cached = a2aDeliveries.get(deliveryKey);
        const text = cached?.draft.text || await directA2AReply(agent, prompt);
        const draft: A2ATurnDraft = cached?.draft || { intent: 'response', text, claims: [], questions: [] };
        if (!cached) { a2aDeliveries.set(deliveryKey, { messageId, taskId: '', agentId: targetAgentId, draft, createdAt: new Date().toISOString() }); await persistA2AState(); }
        return json(res, 200, { jsonrpc: '2.0', id: rpcId, result: { message: { messageId, role: 'ROLE_AGENT', parts: [{ text }], metadata: { agentId: targetAgentId, mode: agent.agentType || 'user' } } } });
      }
      const speaker = z1?.speaker === 'candidate_agent' ? 'candidate_agent' : z1?.speaker === 'requester_agent' ? 'requester_agent' : undefined;
      const round = Number(z1?.round);
      const expectedSpeaker = session.turns.length % 2 === 0 ? 'requester_agent' : 'candidate_agent';
      if (!speaker || ![1, 2, 3].includes(round) || speaker !== expectedSpeaker || targetAgentId !== a2aAgentIdFor(session, speaker) || round !== Math.floor(session.turns.length / 2) + 1) return a2aJsonRpcError(res, rpcId, 409, -32009, 'A2A_TURN_OUT_OF_ORDER');
      const messageId = String(message?.messageId || `z1space:${taskId}:${round}:${speaker}`);
      const deliveryKey = `${targetAgentId}:${messageId}`;
      const cached = a2aDeliveries.get(deliveryKey);
      if (cached) return json(res, 200, a2aTurnResponse(rpcId, taskId, targetAgentId, messageId, cached.draft));
      const draft = await localA2AAdapter.generateTurn({ sessionId: session.id, round: round as 1 | 2 | 3, speaker, agentId: targetAgentId, agentRole: speaker === 'requester_agent' ? 'requester' : 'candidate', topic: session.topic, evidenceLedger: session.evidenceLedger, previousTurns: session.turns });
      a2aDeliveries.set(deliveryKey, { messageId, taskId, agentId: targetAgentId, draft, createdAt: new Date().toISOString() });
      await persistA2AState();
      console.info(`[A2A HTTP] SendMessage task=${taskId} target=${targetAgentId} round=${round}`);
      return json(res, 200, a2aTurnResponse(rpcId, taskId, targetAgentId, messageId, draft));
    }
    const taskMatch = url.pathname.match(/^\/a2a\/tasks\/([^/]+)$/);
    if (taskMatch && req.method === 'GET') {
      if (!validA2ASecret(req)) return json(res, 401, { error: 'A2A_UNAUTHORIZED' });
      const session = a2aSessions.get(decodeURIComponent(taskMatch[1]));
      return session ? json(res, 200, a2aTaskView(session)) : json(res, 404, { error: 'A2A_TASK_NOT_FOUND' });
    }
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
    if (url.pathname === '/auth/delete-account' && req.method === 'POST') return deleteZ1SpaceAccount(req, res);
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
    if (url.pathname === '/api/profile/synthesis' && req.method === 'POST') {
      const input = await body(req, 8_192) as { answers?: unknown };
      const answers = Array.isArray(input.answers) ? input.answers.map(value => synthesisText(value, 420)) : [];
      if (answers.length !== 3 || answers.some(answer => !answer)) return json(res, 400, { error: 'INVALID_PROFILE_ANSWERS' });
      return json(res, 200, await synthesizeProfile(answers, profilePublicFacts(req)));
    }
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, restoreStateForAuthenticatedUser(req, res));
    if (url.pathname === '/api/state' && req.method === 'PUT') { const next = await body(req) as AppState; const id = sessionId(req, res); const current = currentState(req, res); const saved = { ...fresh(), ...next, agentId: current.agentId || fresh().agentId, version: 1, updatedAt: Date.now() }; backfillProfileConfirmation(saved); sessions.set(id, saved); hydrateStateEntities(saved); registerConfirmedAgent(saved); await saveSessions(); return json(res, 200, saved); }
    if (url.pathname === '/api/runs' && req.method === 'POST') { const input = await body(req) as { skill?: Skill }; const state = currentState(req, res); const ownerId = sessionId(req, res);
      // Migrate sessions created by older clients: completing onboarding with
      // three valid impressions is the existing confirmation action.
      if (backfillProfileConfirmation(state)) {
        await saveSessions();
      }
      const profile = snapshotFor(state, ownerId); const requestedSkill = input.skill && state.skills.find(skill => skill.id === input.skill?.id); const event = trigger('skill_run.requested', ownerId, { skillId: input.skill?.id }); const activeRun = [...runs.values()].filter(run => run.ownerId === ownerId && run.skill.id === input.skill?.id).map(run => advance(run)).find(run => run.status === 'running'); const plan = routeTrigger(event, { actorId: ownerId, profile, skills: state.skills, ...(activeRun ? { activeRun: { runId: activeRun.id, skillId: activeRun.skill.id } } : {}) }); if (!plan.accepted) return routeError(res, plan); if (plan.destination !== 'skill-runner' || !profile || !requestedSkill) return json(res, 400, { error: 'SKILL_NOT_FOUND' }); if (plan.existingRunId) { const existing = runs.get(plan.existingRunId)!; return json(res, 202, publicRun(advance(existing))); } clearSeededDiscovery(state); const run = triggeredRun(requestedSkill, ownerId, profile); runs.set(run.id, run); void enrichRun(run, state).catch(error => { run.searchError = true; run.llmError = error instanceof Error ? error.message : 'Skill run failed'; run.llmReady = true; run.timeline.push({ kind: 'agent', text: '本次发现结果暂未保存，请稍后重试。' }); }); state.runs = [...(state.runs || []), { id: run.id, skillId: requestedSkill.id, createdAt: run.createdAt }]; await saveSessions(); return json(res, 202, publicRun(advance(run))); }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/); if (runMatch && req.method === 'GET') { const run = runs.get(runMatch[1]); if (!run || run.ownerId !== sessionId(req, res)) return json(res, 404, { error: 'RUN_NOT_FOUND' }); return json(res, 200, publicRun(advance(run))); }

    const discoverMatch = url.pathname.match(/^\/api\/discover\/(people|content)$/); if (discoverMatch && req.method === 'GET') { const state = currentState(req, res); const ownerId = sessionId(req, res); const profile = snapshotFor(state, ownerId); const skillId = url.searchParams.get('skill_id') || undefined; const runId = url.searchParams.get('run_id') || undefined; const limit = Number(url.searchParams.get('limit') || 10); const event = trigger('explore.requested', ownerId, { target: discoverMatch[1], ...(skillId ? { skillId } : {}), ...(runId ? { runId } : {}), limit }); const plan = routeTrigger(event, { actorId: ownerId, profile, skills: state.skills }); if (!plan.accepted) return routeError(res, plan); if (plan.destination !== 'explore' || !profile) return json(res, 400, { error: 'INVALID_EVENT' }); const run = plan.runId ? runs.get(plan.runId) : undefined; if (plan.runId && !run) return json(res, 404, { error: 'RUN_NOT_FOUND' }); if (run && run.ownerId !== ownerId) return json(res, 404, { error: 'RUN_NOT_FOUND' }); if (run && advance(run).status !== 'completed') return json(res, 409, { error: 'RUN_NOT_COMPLETED' }); const skill = (plan.skillId ? state.skills.find(item => item.id === plan.skillId) : undefined) || run?.skill; const query = url.searchParams.get('q') || (skill ? skillDiscoveryQuery(skill) : discoveryQuery(profile)); const sourceIntent = run ? extractSkillDiscoveryIntent(run) : undefined; if (plan.target === 'people') { const allPeople = peopleForState(state, run); const pool: PeopleCandidate[] = Object.values(allPeople).map(({ id, name, role, bio, tags, topic }) => ({ id, name, role, bio, tags, topic })); const result = recallPeople(run ? pool.filter(candidate => run.matches.includes(candidate.id)) : pool, query, profile, plan.limit); return json(res, 200, { ...result, ...(sourceIntent ? { sourceIntent } : {}), recommendations: saveRecommendationSnapshots(ownerId, query, profile.profileVersion, result.recommendations) }); } const allPosts = postsForState(state, run); const contentById = new Map<string, ContentCandidate>(contents.map(candidate => [candidate.id, candidate])); for (const post of Object.values(allPosts)) contentById.set(post.id, postCandidate(post)); const pool = [...contentById.values()]; const result = recallContent(run ? pool.filter(candidate => run.contentMatches.includes(candidate.id)) : pool, query, profile, plan.limit); return json(res, 200, { ...result, ...(sourceIntent ? { sourceIntent } : {}), recommendations: saveRecommendationSnapshots(ownerId, query, profile.profileVersion, result.recommendations) }); }
    if (url.pathname === '/api/a2a-sessions' && req.method === 'POST') {
      const input = await body(req, 2_048) as { recommendationId?: unknown; runId?: unknown; candidateId?: unknown; idempotencyKey?: unknown };
      const ownerId = sessionId(req, res);
      const recommendationId = typeof input.recommendationId === 'string' && input.recommendationId ? input.recommendationId : undefined;
      const runId = typeof input.runId === 'string' && input.runId ? input.runId : undefined;
      const candidateId = typeof input.candidateId === 'string' && input.candidateId ? input.candidateId : undefined;
      const idempotencyKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey ? input.idempotencyKey : undefined;
      if ((!recommendationId && !candidateId) || (recommendationId && (runId || candidateId)) || !idempotencyKey || idempotencyKey.length > 128 || recommendationId && recommendationId.length > 128 || runId && runId.length > 128 || candidateId && candidateId.length > 128) return json(res, 400, { error: 'INVALID_A2A_REQUEST' });
      const identity = recommendationId || `${runId || 'state'}:${candidateId}`;
      const key = `${ownerId}:${identity}:${idempotencyKey}`;
      const existingId = a2aIdempotency.get(key);
      if (existingId) {
        const existing = a2aSessions.get(existingId);
        if (existing) return json(res, 202, existing);
        a2aIdempotency.delete(key);
      }
      const state = currentState(req, res);
      const profile = snapshotFor(state, ownerId);
      if (!profile) return json(res, 409, { error: 'PROFILE_NOT_CONFIRMED' });
      let recommendation: RecommendationSnapshot | undefined;
      if (recommendationId) {
        recommendation = recommendationSnapshots.get(recommendationKey(ownerId, recommendationId));
      } else {
        const resolved = resolveCandidateRecommendation(ownerId, state, profile, runId, candidateId!);
        if ('error' in resolved) return json(res, resolved.error === 'RUN_NOT_COMPLETED' ? 409 : 404, { error: resolved.error });
        recommendation = resolved.recommendation;
      }
      if (!recommendation) return json(res, 404, { error: 'RECOMMENDATION_NOT_FOUND' });
      if (recommendation.targetType !== 'person' || recommendation.verdict !== 'recommended' || !recommendation.a2aEligible) return json(res, 409, { error: 'A2A_NOT_ELIGIBLE' });
      pruneA2ASessions(ownerId);
      if (!hasA2ACapacity(ownerId)) return json(res, 429, { error: 'A2A_CAPACITY_REACHED' });
      if (profile.profileVersion !== recommendation.profileVersion) return json(res, 409, { error: 'PROFILE_VERSION_CHANGED' });
      const candidate = peopleForState(state)[recommendation.candidateId];
      if (!candidate) return json(res, 404, { error: 'CANDIDATE_NOT_FOUND' });
      registerDynamicPerson(candidate);
      const candidateProfile = await candidateProfileProvider.getPublicProfile(recommendation.candidateId);
      if (!candidateProfile) return json(res, 404, { error: 'CANDIDATE_PROFILE_NOT_FOUND' });
      const racedId = a2aIdempotency.get(key);
      if (racedId) return json(res, 202, a2aSessions.get(racedId));
      if (!hasA2ACapacity(ownerId)) return json(res, 429, { error: 'A2A_CAPACITY_REACHED' });
      const session = createA2ASession(recommendation, profile, candidateProfile);
      const withTransport = Object.freeze({ ...session, requesterAgentId: state.agentId || `agent:${ownerId}`, candidateAgentId: candidate.agentId || `agent:public:${candidate.id}`, candidateAgentType: candidate.agentType || 'public_profile_proxy', transport: 'http-jsonrpc' as const });
      a2aSessions.set(withTransport.id, withTransport);
      a2aIdempotency.set(key, withTransport.id);
      await persistA2AState();
      startA2ASession(withTransport);
      return json(res, 202, withTransport);
    }

    if (url.pathname === '/api/a2a-sessions' && req.method === 'GET') { const state = currentState(req, res); const ownerId = sessionId(req, res); const agentId = state.agentId; return json(res, 200, [...a2aSessions.values()].filter(session => session.requesterId === ownerId || a2aAgentIdFor(session, 'candidate_agent') === agentId)); }
    const a2aMatch = url.pathname.match(/^\/api\/a2a-sessions\/([^/]+)$/); if (a2aMatch && req.method === 'GET') { const session = a2aSessions.get(a2aMatch[1]); const ownerId = sessionId(req, res); const state = currentState(req, res); if (!session || (session.requesterId !== ownerId && a2aAgentIdFor(session, 'candidate_agent') !== state.agentId)) return json(res, 404, { error: 'A2A_SESSION_NOT_FOUND' }); return json(res, 200, session); }
    const chatMatch = url.pathname.match(/^\/api\/agent-chats\/([^/]+)\/messages$/); if (chatMatch && req.method === 'POST') {
      const state = currentState(req, res);
      const ownerId = sessionId(req, res);
      const person = peopleForState(state)[chatMatch[1]];
      if (!person) return json(res, 404, { error: 'PERSON_NOT_FOUND' });
      registerDynamicPerson(person);
      const input = await body(req) as { text?: string };
      const chatKey = `${ownerId}:${person.id}`;
      const persistedMessages = state.agentChats?.[person.id];
      const messages = agentChats.get(chatKey) || (Array.isArray(persistedMessages) ? persistedMessages.map(message => ({ ...message })) : [{ from: 'agent', text: person.greeting, time: new Date().toISOString() }]);
      if (input.text?.trim()) {
        messages.push({ from: 'me', text: input.text.trim(), time: new Date().toISOString() });
        let reply = `围绕「${person.topic}」，我的建议是先从具体经历聊起。你也可以问我：${person.reason}`;
        try { reply = await deepseekChat([{ role: 'system', content: `你是 ${person.name} 的个人 Agent，只能根据以下公开画像回答。你不是本人，不要冒充真人；语气友好、具体，回答控制在180字内，并给出一个可继续交流的问题。画像：${JSON.stringify(person)}` }, ...messages.slice(-8).map(m => ({ role: m.from === 'me' ? 'user' as const : 'assistant' as const, content: m.text }))]) || reply; } catch { /* keep a deterministic fallback when the provider is unavailable */ }
        messages.push({ from: 'agent', text: reply, time: new Date().toISOString() });
      }
      const savedMessages = messages.map(message => ({ ...message }));
      agentChats.set(chatKey, savedMessages);
      state.agentChats = { ...(state.agentChats || {}), [person.id]: savedMessages };
      await saveSessions();
      return json(res, 200, { person, messages: savedMessages, provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'fallback' });
    }
    const file = staticPath(url.pathname); if (file) { const content = await readFile(file); const type = extname(file) === '.js' ? 'text/javascript; charset=utf-8' : extname(file) === '.png' ? 'image/png' : 'text/html; charset=utf-8'; res.writeHead(200, { 'content-type': type }); return res.end(content); }
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) { if (error instanceof RequestBodyTooLarge) return json(res, 413, { error: 'REQUEST_TOO_LARGE' }); if (error instanceof HumanChatError) return json(res, error.status, { error: error.code }); console.error(error); return json(res, 500, { error: 'INTERNAL_ERROR' }); }
});
await loadSessions();
await loadA2AState();
server.listen(port, async () => {
  console.log(`Z1Space running at http://localhost:${port}`);
  for (const session of a2aSessions.values()) if (['created', 'running', 'observing'].includes(session.status)) startA2ASession(session);
});
