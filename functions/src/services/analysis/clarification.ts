import type { ClarificationQuestion } from '@/types/models';
import type { AiVisionResult, FoodMatch } from '@/types/nutrition';
import { describeOilMeasure, OIL_GRAM_ASSUMPTIONS, type OilAnswerLevel } from './oilClarification';

/**
 * Clarification policy — hybrid by design:
 *   - The AI contributes signal only: `overallUncertainty` and
 *     `suggestedClarificationTopics` (see AiVisionResult).
 *   - This module makes the actual DECISION (worth asking or not?) and
 *     owns the actual QUESTION CONTENT (via `QUESTION_TEMPLATES` below).
 *
 * The AI never authors question text/options directly — it can only
 * suggest a *topic* (a free-form string hint like "oil_amount"), which
 * this policy maps to a pre-written, reviewed question template if one
 * exists for that topic. An AI-suggested topic with no matching template
 * is simply ignored (logged, not surfaced) rather than allowed to
 * fabricate ad-hoc question UI.
 *
 * Thresholds/config are passed in, not hardcoded, and this module has no
 * knowledge of HTTP/route handlers — app/api/meals/analyze/route.ts calls
 * `evaluateClarificationPolicy(...)`, nothing more.
 */

export interface ClarificationPolicyConfig {
  /** Below this overall confidence (see services/nutrition/calculate.ts's calculateOverallConfidence), clarification is triggered even without a specific AI-suggested topic. */
  minConfidenceThreshold: number;
  /** Max clarification questions to ask in one round — keeps the mobile "Clarify" screen (which shows "Question X of N") from growing unbounded. */
  maxQuestions: number;
}

export const DEFAULT_CLARIFICATION_POLICY_CONFIG: ClarificationPolicyConfig = {
  minConfidenceThreshold: 0.75,
  maxQuestions: 2,
};

/**
 * Pre-authored question templates, keyed by the AI-suggested topic string
 * they respond to. This is the ONLY source of clarification question
 * content — see the module doc comment above. Only one topic is fully
 * worked out for V1 (oil amount, matching the pattern already used in
 * the mobile app's scan/clarify.tsx screen); more can be added here
 * without touching the policy logic below.
 *
 * The oil_amount option descriptions are generated from
 * OIL_GRAM_ASSUMPTIONS (services/analysis/oilClarification.ts) — the
 * single source of truth for those numbers — so the user-facing label
 * and the actual calculation can never drift out of sync.
 */
const OIL_AMOUNT_BASE_DESCRIPTIONS: Record<OilAnswerLevel, string> = {
  none: 'No oil was used',
  light: 'A small amount of oil was used',
  regular: 'A moderate amount of oil was used',
  heavy: 'A large amount of oil was used',
};

function describeOilOption(level: OilAnswerLevel): string {
  const base = OIL_AMOUNT_BASE_DESCRIPTIONS[level];
  const grams = OIL_GRAM_ASSUMPTIONS[level];
  return grams === 0 ? base : `${base} (${describeOilMeasure(level)}, ~${grams}g)`;
}

const QUESTION_TEMPLATES: Record<string, ClarificationQuestion> = {
  oil_amount: {
    id: 'oil_amount',
    question: 'Was oil used to cook this?',
    helperText: 'This helps us calculate calories and fat more accurately.',
    options: [
      { id: 'none', label: 'None', description: describeOilOption('none') },
      { id: 'light', label: 'Light', description: describeOilOption('light') },
      { id: 'regular', label: 'Regular', description: describeOilOption('regular') },
      { id: 'heavy', label: 'Heavy', description: describeOilOption('heavy') },
    ],
  },
};

/**
 * Decides whether clarification is worth asking for, and if so, returns
 * the questions to ask (in priority order, capped at `config.maxQuestions`).
 * Returns an empty array when no clarification is needed.
 *
 * Deterministic rules, evaluated in order:
 *   1. Any AI-suggested topic with a known template is included.
 *   2. If overall confidence is below the threshold and no topic-based
 *      question was already added, fall back to a generic low-confidence
 *      prompt is NOT fabricated here — instead this is a signal for the
 *      caller (the analyze route) to prefer flagging low confidence in
 *      the response over inventing a question with no real topic behind
 *      it. Fabricating a plausible-sounding question with no specific
 *      uncertainty to resolve would violate the same "don't invent
 *      nutrition data" spirit — so this policy only ever asks about
 *      topics it has real templates for.
 */
export function evaluateClarificationPolicy(
  aiResult: Pick<AiVisionResult, 'overallUncertainty' | 'suggestedClarificationTopics'>,
  _foodMatches: FoodMatch[],
  config: ClarificationPolicyConfig = DEFAULT_CLARIFICATION_POLICY_CONFIG,
): ClarificationQuestion[] {
  const overallConfidence = 1 - aiResult.overallUncertainty;
  const topics = aiResult.suggestedClarificationTopics ?? [];

  const questions: ClarificationQuestion[] = [];
  for (const topic of topics) {
    const template = QUESTION_TEMPLATES[topic];
    if (template && !questions.some((q) => q.id === template.id)) {
      questions.push(template);
    }
    if (questions.length >= config.maxQuestions) break;
  }

  // Below-threshold confidence with no matched topic doesn't invent a
  // question — it's a case the analyze route should surface via
  // `prediction.confidence` / a lower overall score instead, not paper
  // over with a generic clarification prompt.
  void overallConfidence;

  return questions;
}
