import { describe, expect, it } from 'vitest';
import {
  classifyProblem,
  resolveProblemClassification,
  validateAiClassificationOutput,
  classificationDecisionMetadata,
  LEGACY_PAIN_CLASSIFICATION_FIXTURES,
  type AiProblemClassifier,
} from '../src/index.js';

describe('problem classification', () => {
  it.each([
    ['кем стать после школы', 'DIRECTION'],
    ['не понимаю тему дробей', 'KNOWLEDGE_GAP'],
    ['хочу научиться делать сайты', 'SKILL'],
    ['у меня нет опыта для стажировки', 'PRACTICE_READINESS'],
  ] as const)('classifies %s deterministically as %s', (text, type) => {
    expect(classifyProblem(text)).toMatchObject({
      type,
      status: 'classified',
      path: 'deterministic',
    });
  });

  it('is reproducible and makes conflicting or absent signals ambiguous', () => {
    expect(classifyProblem('привет')).toMatchObject({ type: null, status: 'ambiguous' });
    expect(classifyProblem('кем стать, если не понимаю математику')).toMatchObject({
      type: null,
      status: 'ambiguous',
    });
    expect(classifyProblem('не понимаю тему дробей')).toEqual(
      classifyProblem('не понимаю тему дробей'),
    );
  });

  it.each(LEGACY_PAIN_CLASSIFICATION_FIXTURES)(
    'keeps legacy fixture $id as the four-type behaviour contract',
    ({ text, expected }) => {
      expect(classifyProblem(text).type).toBe(expected);
    },
  );

  it('never calls AI for a confident deterministic outcome', async () => {
    let calls = 0;
    const ai: AiProblemClassifier = {
      modelIdentifier: 'fake-v1',
      classify() {
        calls += 1;
        return Promise.resolve({
          type: 'SKILL',
          confidence: 1,
          reason: 'wrong',
          clarification_needed: false,
        });
      },
    };
    await expect(resolveProblemClassification('не понимаю дроби', ai)).resolves.toMatchObject({
      type: 'KNOWLEDGE_GAP',
    });
    expect(calls).toBe(0);
  });

  it('fails safe on invalid AI output and validates only the four types', async () => {
    expect(
      validateAiClassificationOutput({
        type: 'FIFTH',
        confidence: 1,
        reason: 'x',
        clarification_needed: false,
      }),
    ).toBeNull();
    const ai: AiProblemClassifier = {
      modelIdentifier: 'fake-v1',
      classify() {
        return Promise.resolve({ type: 'FIFTH' });
      },
    };
    await expect(resolveProblemClassification('привет', ai)).resolves.toMatchObject({
      type: null,
      status: 'ambiguous',
      providerResult: 'invalid',
    });
  });

  it('keeps raw user text out of decision-event metadata', () => {
    const metadata = classificationDecisionMetadata(classifyProblem('не понимаю дроби'), 'trace-1');
    expect(JSON.stringify(metadata)).not.toContain('дроби');
    expect(metadata).toMatchObject({
      classification: { type: 'KNOWLEDGE_GAP' },
      traceId: 'trace-1',
    });
  });
});
