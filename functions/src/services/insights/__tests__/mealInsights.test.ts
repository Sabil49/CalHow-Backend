import { describe, expect, it } from 'vitest';
import { buildInsightsPrompt, sanitizeInsights } from '../mealInsights';
import { localDayBounds } from '@/meals/insights';

describe('buildInsightsPrompt', () => {
  it('includes only the numbers CalHow already has, and marks missing ones as not set', () => {
    const prompt = buildInsightsPrompt({
      meal: {
        mealType: 'lunch',
        calories: 650.4,
        protein: 40,
        carbs: 70,
        fats: 20,
        foods: [{ name: 'grilled chicken breast', portionLabel: '150 g', calories: 248 }],
      },
      dayTotals: { calories: 1200, protein: 60, carbs: 150, fats: 40, fiber: 12 },
      mealsLoggedToday: 2,
      goals: { goalType: 'lose_weight', dailyCalorieTarget: 1800, proteinG: 112 },
      diet: { dietType: 'halal', allergies: ['peanuts'] },
    });
    expect(prompt).toContain('grilled chicken breast — 150 g, 248 kcal');
    expect(prompt).toContain('Meal totals: 650 kcal');
    expect(prompt).toContain('2 meals including this one');
    expect(prompt).toContain('Goal: lose weight');
    expect(prompt).toContain('protein 112 g, carbs not set');
    expect(prompt).toContain('Diet type: halal');
    expect(prompt).toContain('Allergies: peanuts');
    expect(prompt).toContain('Disliked ingredients: none listed');
  });
});

describe('sanitizeInsights', () => {
  it('keeps at most 4, trims, drops empty ones and bounds lengths', () => {
    const result = sanitizeInsights({
      insights: [
        { kind: 'positive', title: '  Great protein  ', body: ' Nice. ' },
        { kind: 'watch', title: '', body: 'no title' },
        { kind: 'suggestion', title: 'x'.repeat(100), body: 'y'.repeat(400) },
        { kind: 'positive', title: 'a', body: 'b' },
        { kind: 'positive', title: 'c', body: 'd' },
        { kind: 'positive', title: 'e', body: 'f' },
      ],
    });
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ kind: 'positive', title: 'Great protein', body: 'Nice.' });
    expect(result[1]!.title).toHaveLength(60);
    expect(result[1]!.body).toHaveLength(280);
  });
});

describe('localDayBounds', () => {
  it('finds the local day for a UTC+5:30 user (getTimezoneOffset = -330)', () => {
    // 2026-09-30 20:00 UTC is 2026-10-01 01:30 in India.
    const { start, end } = localDayBounds(new Date('2026-09-30T20:00:00Z'), -330);
    expect(start.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-10-01T18:30:00.000Z');
  });

  it('finds the local day for a UTC-7 user (getTimezoneOffset = 420)', () => {
    // 2026-10-01 03:00 UTC is 2026-09-30 20:00 in California.
    const { start } = localDayBounds(new Date('2026-10-01T03:00:00Z'), 420);
    expect(start.toISOString()).toBe('2026-09-30T07:00:00.000Z');
  });
});
