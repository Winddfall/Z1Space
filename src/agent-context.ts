export type PublicBoundary = 'public' | 'private';
export type AgentProfileDimension = 'thinking' | 'interests' | 'connection';

export type AgentProfileSection = Readonly<{
  dimension: AgentProfileDimension;
  impression: string;
  sourceReferences: readonly string[];
  publicBoundary: PublicBoundary;
}>;

export type AgentProfile = Readonly<{
  ownerId: string;
  profileVersion: number;
  sections: readonly [AgentProfileSection, AgentProfileSection, AgentProfileSection];
  confirmedAt?: string;
}>;

export type AgentContextSnapshot = Readonly<{
  ownerId: string;
  profileVersion: number;
  sections: readonly [AgentProfileSection, AgentProfileSection, AgentProfileSection];
  confirmedAt?: string;
}>;

export type ProfileState = {
  impressions?: unknown;
  profileVersion?: unknown;
  profileSourceReferences?: unknown;
  profilePublicBoundaries?: unknown;
  profileConfirmedAt?: unknown;
};

const PROFILE_DIMENSIONS: readonly AgentProfileDimension[] = ['thinking', 'interests', 'connection'];

const DEFAULT_SOURCE_REFERENCES = [
  ['示例回答与产品思考'],
  ['示例关注与实践内容'],
  ['示例介绍与交流偏好']
] as const;

function validatedText(value: unknown, index: number) {
  if (typeof value !== 'string') throw new Error(`PROFILE_IMPRESSION_${index + 1}_INVALID`);
  const text = value.trim();
  if (text.length < 8 || text.length > 420) throw new Error(`PROFILE_IMPRESSION_${index + 1}_INVALID`);
  return text;
}

function sourceReferences(value: unknown, index: number) {
  if (value === undefined) return [...DEFAULT_SOURCE_REFERENCES[index]];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`PROFILE_SOURCE_REFERENCES_${index + 1}_INVALID`);
  }
  return value.map(item => item.trim());
}

function publicBoundary(value: unknown, index: number): PublicBoundary {
  if (value === undefined) return 'private';
  if (value !== 'public' && value !== 'private') throw new Error(`PROFILE_PUBLIC_BOUNDARY_${index + 1}_INVALID`);
  return value;
}

export function buildAgentContextSnapshot(state: ProfileState, ownerId: string): AgentContextSnapshot {
  if (!ownerId.trim()) throw new Error('PROFILE_OWNER_INVALID');
  if (!Array.isArray(state.impressions) || state.impressions.length !== 3) throw new Error('PROFILE_REQUIRES_THREE_IMPRESSIONS');

  const version = state.profileVersion === undefined ? 1 : state.profileVersion;
  if (!Number.isInteger(version) || Number(version) < 1) throw new Error('PROFILE_VERSION_INVALID');

  const refs = state.profileSourceReferences;
  if (refs !== undefined && (!Array.isArray(refs) || refs.length !== 3)) throw new Error('PROFILE_SOURCE_REFERENCES_INVALID');
  const boundaries = state.profilePublicBoundaries;
  if (boundaries !== undefined && (!Array.isArray(boundaries) || boundaries.length !== 3)) throw new Error('PROFILE_PUBLIC_BOUNDARIES_INVALID');
  const confirmedAt = state.profileConfirmedAt;
  if (confirmedAt !== undefined && (typeof confirmedAt !== 'string' || Number.isNaN(Date.parse(confirmedAt)))) throw new Error('PROFILE_CONFIRMED_AT_INVALID');

  const sections = state.impressions.map((value, index) => Object.freeze({
    dimension: PROFILE_DIMENSIONS[index],
    impression: validatedText(value, index),
    sourceReferences: Object.freeze(sourceReferences(Array.isArray(refs) ? refs[index] : undefined, index)),
    publicBoundary: publicBoundary(Array.isArray(boundaries) ? boundaries[index] : undefined, index)
  })) as [AgentProfileSection, AgentProfileSection, AgentProfileSection];

  return Object.freeze({
    ownerId: ownerId.trim(),
    profileVersion: Number(version),
    sections: Object.freeze(sections),
    ...(confirmedAt ? { confirmedAt } : {})
  });
}
