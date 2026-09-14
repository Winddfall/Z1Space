import type { AgentContextSnapshot } from './agent-context.ts';

export type TriggerEventType =
  | 'agent_profile.confirmed'
  | 'skill_run.requested'
  | 'skill_run.completed'
  | 'explore.requested'
  | 'content_interaction.recorded';

export type TriggerEvent = Readonly<{
  schemaVersion: 1;
  eventId: string;
  type: TriggerEventType;
  occurredAt: string;
  source: 'web' | 'skill-runner' | 'system';
  actor: Readonly<{ userId: string; sessionId?: string }>;
  subject?: Readonly<{ kind: 'profile' | 'skill' | 'run' | 'content'; id: string; version?: number }>;
  correlationId: string;
  idempotencyKey?: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type RouterSkill = Readonly<{ id: string; kind?: string; enabled?: boolean }>;

export type RouterContext = Readonly<{
  actorId: string;
  profile: AgentContextSnapshot | null;
  skills: readonly RouterSkill[];
  activeRun?: Readonly<{ runId: string; skillId: string }>;
}>;

export type RoutePlan =
  | Readonly<{ accepted: true; destination: 'profile-store'; command: 'save-profile-version'; profileVersion: number }>
  | Readonly<{ accepted: true; destination: 'skill-runner'; command: 'start-or-reuse-run'; skillId: string; profileVersion: number; correlationId: string; existingRunId?: string }>
  | Readonly<{ accepted: true; destination: 'explore'; command: 'find-candidates'; target: 'people' | 'content'; skillId?: string; runId?: string; limit: number }>
  | Readonly<{ accepted: true; destination: 'run-results'; command: 'publish-run-result'; runId: string; status: 'succeeded' | 'failed' }>
  | Readonly<{ accepted: true; destination: 'profile-context'; command: 'record-content-interaction'; contentId: string; action: 'useful' | 'known' | 'disagree' | 'want_to_talk' }>
  | Readonly<{ accepted: false; code: 'INVALID_EVENT' | 'ACTOR_MISMATCH' | 'PROFILE_NOT_CONFIRMED' | 'SKILL_NOT_FOUND' | 'SKILL_DISABLED' | 'UNSUPPORTED_TRIGGER' }>;

const EVENT_TYPES = new Set<TriggerEventType>([
  'agent_profile.confirmed', 'skill_run.requested', 'skill_run.completed', 'explore.requested', 'content_interaction.recorded'
]);

export function isTriggerEvent(value: unknown): value is TriggerEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TriggerEvent>;
  return event.schemaVersion === 1
    && typeof event.eventId === 'string' && event.eventId.length > 0
    && typeof event.type === 'string' && EVENT_TYPES.has(event.type as TriggerEventType)
    && typeof event.occurredAt === 'string' && !Number.isNaN(Date.parse(event.occurredAt))
    && (event.source === 'web' || event.source === 'skill-runner' || event.source === 'system')
    && !!event.actor && typeof event.actor.userId === 'string' && event.actor.userId.length > 0
    && typeof event.correlationId === 'string' && event.correlationId.length > 0
    && !!event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload);
}

function reject(code: Extract<RoutePlan, { accepted: false }>['code']): RoutePlan {
  return Object.freeze({ accepted: false, code });
}

export function routeTrigger(event: unknown, context: RouterContext): RoutePlan {
  if (!isTriggerEvent(event)) return reject('INVALID_EVENT');
  if (event.actor.userId !== context.actorId) return reject('ACTOR_MISMATCH');

  if (event.type === 'agent_profile.confirmed') {
    const version = event.payload.profileVersion;
    return Number.isInteger(version) && Number(version) > 0
      ? Object.freeze({ accepted: true, destination: 'profile-store', command: 'save-profile-version', profileVersion: Number(version) })
      : reject('INVALID_EVENT');
  }

  if (!context.profile) return reject('PROFILE_NOT_CONFIRMED');

  if (event.type === 'skill_run.requested') {
    const skillId = event.payload.skillId;
    if (typeof skillId !== 'string' || !skillId) return reject('INVALID_EVENT');
    const skill = context.skills.find(item => item.id === skillId);
    if (!skill) return reject('SKILL_NOT_FOUND');
    if (!skill.enabled) return reject('SKILL_DISABLED');
    const existingRunId = context.activeRun?.skillId === skillId ? context.activeRun.runId : undefined;
    return Object.freeze({ accepted: true, destination: 'skill-runner', command: 'start-or-reuse-run', skillId, profileVersion: context.profile.profileVersion, correlationId: event.correlationId, ...(existingRunId ? { existingRunId } : {}) });
  }

  if (event.type === 'explore.requested') {
    const target = event.payload.target;
    if (target !== 'people' && target !== 'content') return reject('INVALID_EVENT');
    const skillId = typeof event.payload.skillId === 'string' ? event.payload.skillId : undefined;
    if (skillId && !context.skills.some(skill => skill.id === skillId)) return reject('SKILL_NOT_FOUND');
    const limit = typeof event.payload.limit === 'number' && Number.isInteger(event.payload.limit)
      ? Math.min(20, Math.max(1, event.payload.limit))
      : 10;
    return Object.freeze({ accepted: true, destination: 'explore', command: 'find-candidates', target, ...(skillId ? { skillId } : {}), ...(typeof event.payload.runId === 'string' ? { runId: event.payload.runId } : {}), limit });
  }

  if (event.type === 'skill_run.completed') {
    const { runId, status } = event.payload;
    return typeof runId === 'string' && (status === 'succeeded' || status === 'failed')
      ? Object.freeze({ accepted: true, destination: 'run-results', command: 'publish-run-result', runId, status })
      : reject('INVALID_EVENT');
  }

  if (event.type === 'content_interaction.recorded') {
    const { contentId, action } = event.payload;
    const actions = ['useful', 'known', 'disagree', 'want_to_talk'];
    return typeof contentId === 'string' && actions.includes(String(action))
      ? Object.freeze({ accepted: true, destination: 'profile-context', command: 'record-content-interaction', contentId, action: action as 'useful' | 'known' | 'disagree' | 'want_to_talk' })
      : reject('INVALID_EVENT');
  }

  return reject('UNSUPPORTED_TRIGGER');
}
