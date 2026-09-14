import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildAgentContextSnapshot, type AgentContextSnapshot } from './agent-context.ts';
import { recallContent, recallPeople, type ContentCandidate, type PeopleCandidate } from './explore.ts';
import { routeTrigger, type TriggerEvent } from './trigger-router.ts';

type Skill = { id: string; name: string; kind?: string; goal?: string; keywords?: string; enabled?: boolean; profileDescription?: string; profileTitle?: string; [key: string]: unknown };
type AppState = { version: number; step: string; name: string; impressions: string[]; skills: Skill[]; following: string[]; liked: string[]; saved: string[]; chats: Record<string, unknown>; runs: unknown[]; discoverIds: string[]; contentIds: string[]; lastView: string; agentChats?: Record<string, AgentMessage[]>; [key: string]: unknown };
type AgentMessage = { from: 'me' | 'agent'; text: string; time: string };
type Run = { id: string; skill: Skill; createdAt: number; status: 'running' | 'completed'; stage: number; timeline: { text: string; kind: 'agent' | 'user' }[]; matches: string[]; llmReady?: boolean; llmError?: string };
type TriggeredRun = Run & { ownerId: string; profileSnapshot: AgentContextSnapshot };

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.Z1SPACE_DATA_DIR || join(root, '.data');
const stateFile = join(dataDir, 'sessions.json');
const sessions = new Map<string, AppState>();
const runs = new Map<string, TriggeredRun>();
const agentChats = new Map<string, AgentMessage[]>();

const people: Record<string, { id: string; name: string; role: string; bio: string; tags: string[]; reason: string; topic: string; greeting: string }> = {
  chen: { id: 'chen', name: '陈序', role: '独立开发者 · AI 产品实践', bio: '在做让复杂任务变简单的工具。写过代码，也踩过产品的坑。', tags: ['AI 产品', '独立开发', '交互'], reason: '他有 AI 产品落地经验，与你都在思考如何把复杂任务变简单。', topic: 'AI 产品应该先做聊天入口，还是任务流程？', greeting: '你好，我是陈序。看到你也在研究 AI 产品入口，我正好有一次改版经历可以分享。' },
  xia: { id: 'xia', name: '许知夏', role: '用户研究员 · 关注人与技术', bio: '喜欢把“用户需要什么”问得再具体一点。', tags: ['用户研究', '产品', 'AI'], reason: '她关注 AI 如何进入真实场景，与你对真实用户需求的兴趣一致。', topic: '做第一个 AI 产品时，应该先问用户什么？', greeting: '你好呀，我是知夏。很想听听你最近遇到的真实用户问题。' },
  zhou: { id: 'zhou', name: '周予', role: '交互设计师 · 自由创作者', bio: '关心界面的细节，也关心一个产品给人的感觉。', tags: ['交互设计', 'AI 产品', '设计'], reason: '他习惯从具体交互讨论产品取舍，与你关注的问题直接相关。', topic: 'Agent 应该主动到什么程度？', greeting: '你好，我是周予。最近也在画 Agent 产品的交互流程，可以一起聊聊。' }
};

const contents: ContentCandidate[] = [
  { id: 'p1', authorId: 'chen', title: '做了三个月 AI 工具，我把聊天框从首页拿掉了', excerpt: '把高频任务和开放探索分开，让用户更容易开始。', tags: ['AI 产品', '独立开发', '交互'] },
  { id: 'p3', authorId: 'zhou', title: 'Agent 的主动性，需要一个让人放心的边界', excerpt: '展示 Agent 正在查找什么、分享什么，以及下一步由谁确认。', tags: ['Agent', '交互设计', 'AI 产品'] },
  { id: 'p5', title: '我不再追求整理好所有笔记', excerpt: '让知识在具体问题里被调用，比保持目录整齐更重要。', tags: ['知识管理', '阅读', '学习'] }
];

function fresh(): AppState { return { version: 1, step: 'auth', name: '小林', impressions: [], skills: [], following: [], liked: [], saved: [], chats: {}, runs: [], discoverIds: ['chen', 'xia', 'zhou'], contentIds: [], lastView: 'discover', agentChats: {} }; }
function json(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); }
async function body(req: IncomingMessage) { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; }
function sessionId(req: IncomingMessage) { return String(req.headers['x-z1-session'] || 'demo-session'); }
async function saveSessions() { await mkdir(dataDir, { recursive: true }); await writeFile(stateFile, JSON.stringify(Object.fromEntries(sessions), null, 2)); }
async function loadSessions() { if (!existsSync(stateFile)) return; try { const saved = JSON.parse(await readFile(stateFile, 'utf8')); for (const [id, value] of Object.entries(saved)) sessions.set(id, value as AppState); } catch { /* a corrupt demo file should not block a fresh session */ } }
function currentState(req: IncomingMessage) { const id = sessionId(req); if (!sessions.has(id)) sessions.set(id, fresh()); return sessions.get(id)!; }
function profileDescription(skill: Skill) { const goal = String(skill.goal || '').trim().replace(/[。.!！?？]+$/, ''); return goal ? `正在通过 Agent：${goal}，并把这轮探索中形成的连接沉淀为个人画像。` : `正在使用「${skill.name}」探索值得认识的人与信息。`; }
function runFor(skill: Skill): Run { const terms = `${skill.name} ${skill.goal || ''} ${skill.keywords || ''}`.toLowerCase(); const matches = Object.values(people).filter(p => p.tags.some(t => terms.includes(t.toLowerCase())) || terms.includes('人') || terms.includes('实习')).slice(0, 2).map(p => p.id); return { id: randomUUID(), skill, createdAt: Date.now(), status: 'running', stage: 0, timeline: [{ kind: 'agent', text: `收到，我开始执行「${skill.name}」。我会先理解你的目标，再寻找有依据的连接。` }], matches: matches.length ? matches : ['chen', 'xia'], llmReady: !process.env.DEEPSEEK_API_KEY }; }
function triggeredRun(skill: Skill, ownerId: string, profileSnapshot: AgentContextSnapshot): TriggeredRun { return { ...runFor(skill), ownerId, profileSnapshot }; }
function publicRun(run: TriggeredRun) { const { ownerId: _ownerId, profileSnapshot: _profileSnapshot, ...value } = run; return { ...value, profileVersion: run.profileSnapshot.profileVersion }; }
function trigger(type: TriggerEvent['type'], ownerId: string, payload: Record<string, unknown>, source: TriggerEvent['source'] = 'web'): TriggerEvent { const eventId = randomUUID(); return { schemaVersion: 1, eventId, type, occurredAt: new Date().toISOString(), source, actor: { userId: ownerId, sessionId: ownerId }, correlationId: eventId, payload }; }
function snapshotFor(state: AppState, ownerId: string) { try { return buildAgentContextSnapshot(state, ownerId); } catch { return null; } }
function routeError(res: ServerResponse, plan: { accepted: false; code: string }) { const status = plan.code === 'PROFILE_NOT_CONFIRMED' || plan.code === 'SKILL_DISABLED' ? 409 : 400; return json(res, status, { error: plan.code }); }

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
  if (!process.env.DEEPSEEK_API_KEY) return;
  try {
    const candidateList = run.matches.map(id => people[id]).filter(Boolean).map(p => ({ id: p.id, name: p.name, role: p.role, bio: p.bio, tags: p.tags, topic: p.topic }))
    const content = await deepseekChat([
      { role: 'system', content: '你是 Z1Space 的匹配 Agent。请基于用户 Skill 和候选人的公开简介，给出可靠、克制、有行动价值的匹配结果。只输出 JSON，格式为 {"matches":[{"id":"候选人id","reason":"不超过80字的匹配理由","opening":"一个适合用户继续询问对方 Agent 的问题"}],"summary":"不超过80字的总结"}。不要编造候选人资料。' },
      { role: 'user', content: JSON.stringify({ skill: run.skill, candidates: candidateList }) }
    ], { response_format: { type: 'json_object' }, max_tokens: 700 });
    const parsed = JSON.parse(content || '{}') as { matches?: { id: string; reason?: string; opening?: string }[]; summary?: string };
    const enriched = (parsed.matches || []).filter(x => people[x.id]);
    if (enriched.length) run.matches = enriched.map(x => x.id);
    if (parsed.summary) run.timeline.push({ kind: 'agent', text: parsed.summary });
    for (const match of enriched) { if (match.reason && people[match.id]) people[match.id].reason = match.reason; if (match.opening && people[match.id]) people[match.id].topic = match.opening; }
    run.llmReady = true;
  } catch (error) { run.llmError = error instanceof Error ? error.message : 'DeepSeek request failed'; run.llmReady = true; run.timeline.push({ kind: 'agent', text: '模型暂时不可用，我先用本地匹配结果继续，不影响你查看候选人。' }); }
}
function advance(run: Run) { const elapsed = Date.now() - run.createdAt; const stage = Math.min(run.llmReady ? 3 : 2, Math.floor(elapsed / 650)); while (run.stage < stage) { run.stage += 1; if (run.stage === 1) run.timeline.push({ kind: 'agent', text: '我正在把你的需求拆成几个可匹配的线索，避免只按关键词机械搜索。' }); if (run.stage === 2) run.timeline.push({ kind: 'agent', text: `我找到了 ${run.matches.length} 位可能有帮助的人，正在整理他们与你的共同话题。` }); if (run.stage === 3) { run.status = 'completed'; run.timeline.push({ kind: 'agent', text: '有结果了。下面的人物卡片来自本次任务的匹配依据，你可以先与他们的 Agent 交流，了解更多情况。' }); } } return run; }
function staticPath(pathname: string) { if (pathname === '/') return join(root, 'Z1Space.html'); if (pathname === '/z1space-client.js') return join(root, 'public', 'z1space-client.js'); return null; }

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,PUT,POST,OPTIONS', 'access-control-allow-headers': 'Content-Type,X-Z1-Session' }); return res.end(); }
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'z1space-api' });
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, currentState(req));
    if (url.pathname === '/api/state' && req.method === 'PUT') { const next = await body(req) as AppState; sessions.set(sessionId(req), { ...fresh(), ...next, version: 1 }); await saveSessions(); return json(res, 200, sessions.get(sessionId(req))); }
    if (url.pathname === '/api/runs' && req.method === 'POST') { const input = await body(req) as { skill?: Skill }; const state = currentState(req); const ownerId = sessionId(req); const profile = snapshotFor(state, ownerId); const requestedSkill = input.skill && state.skills.find(skill => skill.id === input.skill?.id); const event = trigger('skill_run.requested', ownerId, { skillId: input.skill?.id }); const activeRun = [...runs.values()].find(run => run.ownerId === ownerId && run.skill.id === input.skill?.id && run.status === 'running'); const plan = routeTrigger(event, { actorId: ownerId, profile, skills: state.skills, ...(activeRun ? { activeRun: { runId: activeRun.id, skillId: activeRun.skill.id } } : {}) }); if (!plan.accepted) return routeError(res, plan); if (plan.destination !== 'skill-runner' || !profile || !requestedSkill) return json(res, 400, { error: 'SKILL_NOT_FOUND' }); if (plan.existingRunId) { const existing = runs.get(plan.existingRunId)!; return json(res, 202, { ...publicRun(advance(existing)), people }); } const run = triggeredRun(requestedSkill, ownerId, profile); runs.set(run.id, run); void enrichRun(run); state.runs = [...(state.runs || []), { id: run.id, skillId: requestedSkill.id, createdAt: run.createdAt }]; await saveSessions(); return json(res, 202, { ...publicRun(advance(run)), people }); }
    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/); if (runMatch && req.method === 'GET') { const run = runs.get(runMatch[1]); if (!run || run.ownerId !== sessionId(req)) return json(res, 404, { error: 'RUN_NOT_FOUND' }); return json(res, 200, { ...publicRun(advance(run)), people }); }
    const discoverMatch = url.pathname.match(/^\/api\/discover\/(people|content)$/); if (discoverMatch && req.method === 'GET') { const state = currentState(req); const ownerId = sessionId(req); const profile = snapshotFor(state, ownerId); const skillId = url.searchParams.get('skill_id') || undefined; const runId = url.searchParams.get('run_id') || undefined; const limit = Number(url.searchParams.get('limit') || 10); const event = trigger('explore.requested', ownerId, { target: discoverMatch[1], ...(skillId ? { skillId } : {}), ...(runId ? { runId } : {}), limit }); const plan = routeTrigger(event, { actorId: ownerId, profile, skills: state.skills }); if (!plan.accepted) return routeError(res, plan); if (plan.destination !== 'explore' || !profile) return json(res, 400, { error: 'INVALID_EVENT' }); const run = plan.runId ? runs.get(plan.runId) : undefined; if (run && run.ownerId !== ownerId) return json(res, 404, { error: 'RUN_NOT_FOUND' }); const skill = (plan.skillId ? state.skills.find(item => item.id === plan.skillId) : undefined) || run?.skill; const query = url.searchParams.get('q') || `${skill?.goal || ''} ${skill?.keywords || ''}`.trim() || profile.sections.map(section => section.impression).join(' '); if (plan.target === 'people') { const pool: PeopleCandidate[] = Object.values(people).map(({ id, name, role, bio, tags, topic }) => ({ id, name, role, bio, tags, topic })); return json(res, 200, recallPeople(run ? pool.filter(candidate => run.matches.includes(candidate.id)) : pool, query, profile, plan.limit)); } return json(res, 200, recallContent(contents, query, profile, plan.limit)); }
    const chatMatch = url.pathname.match(/^\/api\/agent-chats\/([^/]+)\/messages$/); if (chatMatch && req.method === 'POST') { const person = people[chatMatch[1]]; if (!person) return json(res, 404, { error: 'PERSON_NOT_FOUND' }); const input = await body(req) as { text?: string }; const messages = agentChats.get(person.id) || [{ from: 'agent', text: person.greeting, time: new Date().toISOString() }]; if (input.text?.trim()) { messages.push({ from: 'me', text: input.text.trim(), time: new Date().toISOString() }); let reply = `围绕「${person.topic}」，我的建议是先从具体经历聊起。你也可以问我：${person.reason}`; try { reply = await deepseekChat([{ role: 'system', content: `你是 ${person.name} 的个人 Agent，只能根据以下公开画像回答。你不是本人，不要冒充真人；语气友好、具体，回答控制在180字内，并给出一个可继续交流的问题。画像：${JSON.stringify(person)}` }, ...messages.slice(-8).map(m => ({ role: m.from === 'me' ? 'user' as const : 'assistant' as const, content: m.text }))]) || reply; } catch { /* keep a deterministic fallback when the provider is unavailable */ } messages.push({ from: 'agent', text: reply, time: new Date().toISOString() }); } agentChats.set(person.id, messages); return json(res, 200, { person, messages, provider: process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'fallback' }); }
    const file = staticPath(url.pathname); if (file) { const content = await readFile(file); const type = extname(file) === '.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'; res.writeHead(200, { 'content-type': type }); return res.end(content); }
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) { console.error(error); return json(res, 500, { error: 'INTERNAL_ERROR' }); }
});
await loadSessions();
const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Z1Space running at http://localhost:${port}`));
