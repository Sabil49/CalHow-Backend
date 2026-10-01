import { describe, expect, it } from 'vitest';
import { evaluateClarificationPolicy } from '../clarification';

describe('oil question wording', () => {
  it('names the food(s) it is asking about', () => {
    const [question] = evaluateClarificationPolicy(
      {
        overallUncertainty: 0.2,
        suggestedClarificationTopics: ['oil_amount'],
        detectedFoods: [
          { rawName: 'Chicken Curry', detectionConfidence: 0.8, uncertaintyTopics: ['oil_amount'] },
          { rawName: 'naan', detectionConfidence: 0.9 },
        ],
      },
      [],
    );
    expect(question!.id).toBe('oil_amount');
    expect(question!.question).toBe('Was oil used to cook the chicken curry?');
  });
});
