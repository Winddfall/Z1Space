import type { AgentContextSnapshot } from './agent-context.ts';
export type SkillDiscoveryIntent = Readonly<{
  intent: 'discover_people';
  query: string;
  topic: string;
  constraints: Readonly<{
    targetType: 'person';
    skillKind?: string;
    keywords: readonly string[];
  }>;
  sourceRunId: string;
}>;

export type SkillRunDiscoverySource = Readonly<{
  id: string;
  status: 'running' | 'completed';
  skill: Readonly<{ name: string; kind?: string; goal?: string; keywords?: string }>;
  profileSnapshot?: AgentContextSnapshot;
}>;

export function skillDiscoveryQuery(skill: Readonly<{ name: string; goal?: string; keywords?: string }>) {
  const goal = String(skill.goal || '').trim();
  const keywords = String(skill.keywords || '').trim();
  return [goal, keywords].filter(Boolean).join(' ').trim().slice(0, 140) || skill.name.trim();
}

export function extractSkillDiscoveryIntent(run: SkillRunDiscoverySource): SkillDiscoveryIntent | null {
  if (run.status !== 'completed') return null;
  const goal = String(run.skill.goal || '').trim();
  const keywords = Object.freeze([...new Set(String(run.skill.keywords || '').split(/[\s,，、]+/).map(item => item.trim()).filter(Boolean))]);
  const query = skillDiscoveryQuery(run.skill);
  if (!query) return null;
  return Object.freeze({
    intent: 'discover_people',
    query,
    topic: goal || run.skill.name.trim(),
    constraints: Object.freeze({ targetType: 'person', ...(run.skill.kind ? { skillKind: run.skill.kind } : {}), keywords }),
    sourceRunId: run.id
  });
}
