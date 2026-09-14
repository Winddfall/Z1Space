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

export function extractSkillDiscoveryIntent(run: SkillRunDiscoverySource): SkillDiscoveryIntent | null {
  if (run.status !== 'completed') return null;
  const goal = String(run.skill.goal || '').trim();
  const keywords = Object.freeze([...new Set(String(run.skill.keywords || '').split(/[\s,，、]+/).map(item => item.trim()).filter(Boolean))]);
  const profileQuery = run.profileSnapshot?.sections.filter(section => section.publicBoundary === 'public').map(section => section.impression.trim()).filter(Boolean).join(' ').trim().slice(0, 360) || '';
  const skillQuery = [goal, ...keywords].filter(Boolean).join(' ').trim().slice(0, 140);
  const query = [profileQuery, skillQuery].filter(Boolean).join(' ').trim() || run.skill.name.trim();
  if (!query) return null;
  return Object.freeze({
    intent: 'discover_people',
    query,
    topic: goal || run.skill.name.trim(),
    constraints: Object.freeze({ targetType: 'person', ...(run.skill.kind ? { skillKind: run.skill.kind } : {}), keywords }),
    sourceRunId: run.id
  });
}
