import assert from 'node:assert/strict';
import test from 'node:test';
import { assessMatch } from '../src/match-engine.ts';
import { recommendationGoldenCases } from './fixtures/recommendation-golden-cases.ts';

for (const goldenCase of recommendationGoldenCases) {
  test(`Match Engine Golden Case: ${goldenCase.name}`, () => {
    const result = assessMatch(goldenCase.input);
    assert.equal(result.verdict, goldenCase.expectedVerdict);
    assert.equal(result.a2aEligible, goldenCase.expectedA2AEligible);
    assert.ok(result.reason);
    assert.ok(result.reasonCodes.length > 0);
    for (const value of Object.values(result.metrics)) assert.ok(value >= 0 && value <= 1);
    assert.deepEqual(assessMatch(goldenCase.input), result);
  });
}

test('hard gates prevent weak topic or evidence from becoming recommended', () => {
  const base = recommendationGoldenCases[0].input;
  const lowTopic = assessMatch({ ...base, query: '量子农业' });
  assert.equal(lowTopic.verdict, 'not_recommended');
  assert.ok(lowTopic.reasonCodes.includes('LOW_TOPIC_RELEVANCE'));

  const noEvidence = assessMatch({ ...base, evidenceRefs: [] });
  assert.equal(noEvidence.verdict, 'not_recommended');
  assert.ok(noEvidence.reasonCodes.includes('INSUFFICIENT_EVIDENCE'));
});

test('A2A eligibility requires person, recommendation, exchange value and candidate evidence', () => {
  const base = recommendationGoldenCases[0].input;
  assert.equal(assessMatch({ ...base, evidenceRefs: base.evidenceRefs.filter(ref => ref.sourceType !== 'candidate') }).a2aEligible, false);
  assert.deepEqual(assessMatch(recommendationGoldenCases[5].input).a2aReasons, ['A2A_REQUIRES_PERSON']);
});
