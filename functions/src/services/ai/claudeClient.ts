import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { getAnthropicEnv } from '@/lib/env';
import { ApiRouteError } from '@/lib/apiResponse';

/**
 * Shared Claude access for the CalHow Pro AI features (meal insights, menu
 * scanner), via the official Anthropic SDK. The original meal-photo vision
 * provider (providers/anthropicVisionProvider.ts) predates this and still
 * calls the Messages API directly; it's left as-is so the live scan path
 * doesn't change underneath 1.0 users.
 *
 * Structured output uses `output_config.format` (JSON schema from zod),
 * not forced tool use — current Opus/Sonnet 5.5 models reject a forced
 * `tool_choice`.
 */

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const { ANTHROPIC_API_KEY } = getAnthropicEnv();
    // One retry: the SDK retries 408/409/429/5xx and connection errors.
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY, maxRetries: 1 });
  }
  return client;
}

/**
 * Models that accept `fallbacks: "default"` — on a safety-classifier
 * decline, the API re-runs the request on Anthropic's recommended fallback
 * model instead of returning the refusal.
 */
const DEFAULT_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export interface StructuredCallParams<S extends z.ZodType> {
  model: string;
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: S;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
}

/**
 * One Claude call that must come back as JSON matching `schema`. Every
 * failure — network, timeout, API error, refusal, output that doesn't
 * parse — becomes ApiRouteError('ai_provider_error'), which the handlers
 * already map to a 502 (and, for scans, a refund).
 */
export async function callClaudeStructured<S extends z.ZodType>(
  params: StructuredCallParams<S>,
  client: Pick<Anthropic, 'beta'> = getClient(),
): Promise<z.infer<S>> {
  const fallback = DEFAULT_FALLBACK_MODELS.has(params.model)
    ? { betas: ['server-side-fallback-2026-07-01'] as Anthropic.Beta.AnthropicBeta[], fallbacks: 'default' as const }
    : {};

  let response;
  try {
    response = await client.beta.messages.parse(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: [{ role: 'user', content: params.content }],
        output_config: { format: betaZodOutputFormat(params.schema), effort: params.effort },
        ...fallback,
      },
      { timeout: params.timeoutMs },
    );
  } catch (err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      throw new ApiRouteError('ai_provider_error', `The AI request timed out after ${params.timeoutMs}ms.`);
    }
    if (err instanceof Anthropic.APIError) {
      throw new ApiRouteError('ai_provider_error', `AI provider returned an error (status ${err.status ?? 'unknown'}).`);
    }
    throw new ApiRouteError('ai_provider_error', 'The AI request failed.');
  }

  if (response.stop_reason === 'refusal') {
    throw new ApiRouteError('ai_provider_error', "The AI couldn't process this request.");
  }
  if (response.stop_reason === 'max_tokens' || response.parsed_output == null) {
    throw new ApiRouteError('ai_provider_error', 'The AI returned an incomplete response. Please try again.');
  }
  return response.parsed_output as z.infer<S>;
}
