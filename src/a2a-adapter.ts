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
