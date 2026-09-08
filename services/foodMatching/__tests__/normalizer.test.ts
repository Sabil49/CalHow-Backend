import { describe, expect, it } from 'vitest';
import { normalizeFoodDescription, sanitizePreparationForQuery } from '../normalizer';
import { ApiRouteError } from '@/lib/apiResponse';

describe('normalizeFoodDescription', () => {
  it('uses estimatedPortionGrams directly when present', () => {
    const result = normalizeFoodDescription({ rawName: 'grilled chicken breast', estimatedPortionGrams: 150 });
    expect(result.portionGrams).toBe(150);
    expect(result.normalizedName).toContain('chicken breast');
    expect(result.normalizedName).toContain('grilled');
  });

  it('parses grams from a portion label like "1/2 cup (90 g)" when no explicit gram estimate is given', () => {
    const result = normalizeFoodDescription({ rawName: 'cooked white rice', estimatedPortionLabel: '1/2 cup (90 g)' });
    expect(result.portionGrams).toBe(90);
  });

  it('parses a bare "150g" label', () => {
    const result = normalizeFoodDescription({ rawName: 'boiled egg', estimatedPortionLabel: '150g' });
    expect(result.portionGrams).toBe(150);
  });

  it('detects a preparation keyword from the raw name when none is explicitly provided', () => {
    const result = normalizeFoodDescription({ rawName: 'boiled egg', estimatedPortionGrams: 50 });
    expect(result.normalizedName).toContain('boiled');
  });

  it('prefers an explicit preparationMethod over one detected from text', () => {
    const result = normalizeFoodDescription({ rawName: 'chicken breast', estimatedPortionGrams: 150, preparationMethod: 'roasted' });
    expect(result.normalizedName).toContain('roasted');
  });

  it('strips parenthetical portion notes and punctuation from the search name', () => {
    const result = normalizeFoodDescription({ rawName: 'Chicken Breast (Grilled, 150g)!', estimatedPortionGrams: 150 });
    expect(result.normalizedName).not.toMatch(/[()!,]/);
  });

  it('throws a structured, actionable error instead of guessing a default portion when no grams can be determined', () => {
    expect(() => normalizeFoodDescription({ rawName: 'a bowl of something', estimatedPortionLabel: 'a bowl' })).toThrowError(ApiRouteError);
    try {
      normalizeFoodDescription({ rawName: 'a bowl of something', estimatedPortionLabel: 'a bowl' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRouteError);
      expect((err as ApiRouteError).code).toBe('invalid_request');
    }
  });

  it('rejects a zero or negative portion rather than treating it as valid', () => {
    expect(() => normalizeFoodDescription({ rawName: 'olive oil', estimatedPortionGrams: 0 })).toThrowError(ApiRouteError);
  });
});

describe('sanitizePreparationForQuery', () => {
  it('replaces a forward slash with a space ("boiled/tempered" → "boiled tempered")', () => {
    expect(sanitizePreparationForQuery('boiled/tempered')).toBe('boiled tempered');
  });

  it('replaces a backslash with a space', () => {
    expect(sanitizePreparationForQuery('braised\\simmered')).toBe('braised simmered');
  });

  it('replaces & with " and "', () => {
    expect(sanitizePreparationForQuery('salt & pepper')).toBe('salt and pepper');
  });

  it('handles multiple slashes without joining words ("grilled/toasted/baked" → "grilled toasted baked")', () => {
    expect(sanitizePreparationForQuery('grilled/toasted/baked')).toBe('grilled toasted baked');
  });

  it('strips other non-alpha punctuation', () => {
    expect(sanitizePreparationForQuery('pan-fried!')).toBe('pan fried');
  });

  it('lowercases the result', () => {
    expect(sanitizePreparationForQuery('Roasted')).toBe('roasted');
  });

  it('collapses repeated whitespace', () => {
    expect(sanitizePreparationForQuery('deep   fried')).toBe('deep fried');
  });

  it('passes through a clean single-word preparation unchanged', () => {
    expect(sanitizePreparationForQuery('grilled')).toBe('grilled');
  });

  it('normalizeFoodDescription: slash in preparationMethod does not produce a USDA-invalid query', () => {
    const result = normalizeFoodDescription({
      rawName: 'yellow lentil dal',
      estimatedPortionGrams: 150,
      preparationMethod: 'boiled/tempered',
    });
    expect(result.normalizedName).not.toContain('/');
    expect(result.normalizedName).toContain('boiled');
  });

  it('normalizeFoodDescription: backslash in preparationMethod is sanitized', () => {
    const result = normalizeFoodDescription({
      rawName: 'chicken',
      estimatedPortionGrams: 150,
      preparationMethod: 'braised\\simmered',
    });
    expect(result.normalizedName).not.toContain('\\');
  });
});
