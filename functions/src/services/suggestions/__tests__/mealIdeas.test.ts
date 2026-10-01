import { describe, expect, it } from 'vitest';
import { buildIdeasPrompt, fitsBudget } from '../mealIdeas';
import type { MenuDishResult } from '@/services/menu/menuScan';

describe('buildIdeasPrompt', () => {
  it('passes the budget, protein gap and dietary limits', () => {
    const prompt = buildIdeasPrompt({ remainingCalories: 640.4, remainingProtein: 52, mealType: 'dinner', dietType: 'vegetarian', allergies: ['peanuts'] });
    expect(prompt).toContain('Calories left today: 640 kcal');
    expect(prompt).toContain('Protein still needed today: 52 g');
    expect(prompt).toContain('Diet type: vegetarian');
    expect(prompt).toContain('Allergies: peanuts');
  });
});

describe('fitsBudget', () => {
  const withCalories = (calories: number) => ({ name: 'x', estimate: { prediction: { calories } } }) as unknown as MenuDishResult;
  it('keeps ideas within the budget (10% slack) and drops the rest', () => {
    expect(fitsBudget(withCalories(650), 600)).toBe(true);
    expect(fitsBudget(withCalories(700), 600)).toBe(false);
    expect(fitsBudget({ name: 'x', unavailableReason: 'no match' }, 600)).toBe(false);
  });
});
