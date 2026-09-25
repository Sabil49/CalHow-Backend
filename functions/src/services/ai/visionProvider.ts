import { createAnthropicVisionProvider } from './providers/anthropicVisionProvider';
import type { AiVisionResult } from '@/types/nutrition';

/**
 * The AI vision stage's ONLY job: identify foods, estimate portions and
 * preparation method, and report its own uncertainty. It must NOT
 * produce final calorie/macro numbers — see AiVisionResult's doc comment
 * in types/nutrition.ts for why (structured nutrition data, via USDA
 * FoodData Central, is the source of truth for those, not the model).
 *
 * Deliberately provider-agnostic: nothing in this interface (or in any
 * route handler that calls it) references a specific AI SDK/vendor.
 * Swapping providers means writing one new class under ./providers/ that
 * implements this interface, then changing the one line in the factory
 * below — no route/service code changes elsewhere.
 */
export interface VisionAnalysisInput {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png';
}

export interface VisionProvider {
  analyzeMealImage(input: VisionAnalysisInput): Promise<AiVisionResult>;
}

/**
 * Returns the Anthropic Claude-backed implementation — see
 * ./providers/anthropicVisionProvider.ts for the actual HTTP call, forced
 * structured tool-use output, and the documented reasoning for choosing
 * Claude. Provider-specific code is entirely contained under
 * services/ai/; route handlers only ever see this interface.
 */
export function getVisionProvider(): VisionProvider {
  return createAnthropicVisionProvider();
}
