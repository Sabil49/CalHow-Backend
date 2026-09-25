import { getAnthropicEnv } from '@/lib/env';
import { ApiRouteError } from '@/lib/apiResponse';
import { parseAiVisionResponse } from '../aiResponseSchema';
import type { VisionAnalysisInput, VisionProvider } from '../visionProvider';
import type { AiVisionResult } from '@/types/nutrition';

/**
 * Anthropic Claude as the AI vision provider.
 *
 * WHY CLAUDE: no specific vendor was specified for this phase. Claude has
 * native multi-modal (image) support and — critically for this project's
 * "AI is never the source of truth for nutrition numbers" rule — supports
 * FORCING a structured response via tool-use (`tool_choice`), so the
 * model can only respond by calling our `report_food_detections` tool
 * with arguments matching our schema. There's no code path where the
 * model can "helpfully" also report calories, because the tool's
 * input_schema has no such field at all.
 *
 * This is a documented default, not baked into the `VisionProvider`
 * interface — everything Anthropic-specific (the HTTP call, headers,
 * tool schema, prompt wording) lives in this one file. Swapping
 * providers means writing a new file here and changing one line in
 * ../visionProvider.ts's factory.
 *
 * MODEL: `ANTHROPIC_VISION_MODEL` defaults to `claude-sonnet-5` (see
 * lib/env.ts) — a current, vision-capable model as of this writing.
 * Configurable via the env var, not hardcoded here or in any route
 * handler, so it can be updated as Anthropic's model lineup evolves
 * without a code change.
 *
 * IMAGE PRIVACY: `input.imageBase64` is sent ONLY in the request body
 * below, to Anthropic's API. It is never logged, never included in any
 * error message, and never persisted anywhere in this codebase (see
 * services/analysis/analysisStore.ts's doc comment on the same
 * constraint for Firestore).
 */

const TOOL_NAME = 'report_food_detections';

const SYSTEM_PROMPT = `You are a food identification assistant for a nutrition tracking app. You analyze a photo of a meal and report what foods you see.

Your job is ONLY to identify foods, estimate their preparation and portion size, and report your confidence — you do NOT calculate calories, protein, carbohydrates, fat, or fiber. Those are computed separately from a nutrition database using your portion estimates. Never include or imply specific calorie/macro values in your response.

For each distinct food item visible:
- Identify it as specifically and simply as possible (e.g. "grilled chicken breast", not "meat"; "white rice", not "grain").
- When a meal contains multiple distinct ingredients or components (e.g. rice and a protein side, bread with a curry, a salad with toppings), report EACH as a separate item. Do not collapse a multi-component meal into one composite label (e.g. "chicken fried rice") unless the ingredients are genuinely inseparable and individually unidentifiable. Prefer component-level reporting: "cooked white rice", "chicken pieces", "mixed vegetables".
- Note the preparation/cooking method using a SINGLE word for the most visually apparent method (e.g. "grilled", "fried", "boiled", "raw", "steamed", "baked", "roasted", "braised"). Do NOT use slash notation such as "grilled/toasted" or "boiled/tempered" — choose the ONE most prominent method you can see.
- Estimate its weight in grams based on the visible portion size — always provide a number, even if it's an approximation.
- Optionally give a human-friendly portion description (e.g. "1 medium fillet", "1/2 cup").
- Rate your confidence (0 to 1) that you've correctly identified this specific item.
- If you cannot visually tell whether or how much cooking oil or added fat was used to prepare this food, include "oil_amount" in its uncertaintyTopics. Only use this specific topic — do not invent other topic strings.

Also report your overall confidence (0 to 1) in the entire analysis.

If the image shows no identifiable food at all, return an empty foods array rather than guessing.`;

const USER_PROMPT = 'Identify the food(s) in this photo using the report_food_detections tool.';

const FOOD_DETECTION_TOOL = {
  name: TOOL_NAME,
  description: 'Reports the foods identified in a meal photo, with preparation method, estimated portion, and confidence. Does not report nutrition values.',
  input_schema: {
    type: 'object' as const,
    properties: {
      foods: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The specific food item, e.g. "grilled chicken breast".' },
            preparation: { type: 'string', description: 'Single-word cooking/preparation method, e.g. "grilled", "fried", "raw", "boiled", "roasted". One word only — no slash notation like "grilled/toasted" or "boiled/tempered".' },
            portionGrams: { type: 'number', description: "Best estimate of this food's weight in grams, based on visual portion size. Always provide a number." },
            portionLabel: { type: 'string', description: 'A human-friendly portion description, e.g. "1 medium fillet", "1/2 cup".' },
            confidence: { type: 'number', description: 'Confidence (0 to 1) that this food is correctly identified.' },
            uncertaintyTopics: {
              type: 'array',
              items: { type: 'string', enum: ['oil_amount'] },
              description: 'Include "oil_amount" if cooking oil/fat amount for this food cannot be visually determined. No other values are recognized.',
            },
          },
          required: ['name', 'portionGrams', 'confidence'],
        },
      },
      overallConfidence: { type: 'number', description: 'Overall confidence (0 to 1) in the entire analysis.' },
    },
    required: ['foods', 'overallConfidence'],
  },
};

interface AnthropicContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  content?: AnthropicContentBlock[];
}

export interface AnthropicClientDeps {
  fetchFn: typeof fetch;
}

const defaultDeps: AnthropicClientDeps = { fetchFn: fetch };

export function createAnthropicVisionProvider(deps: AnthropicClientDeps = defaultDeps): VisionProvider {
  return {
    async analyzeMealImage(input: VisionAnalysisInput): Promise<AiVisionResult> {
      const { ANTHROPIC_API_KEY, ANTHROPIC_VISION_MODEL, ANTHROPIC_REQUEST_TIMEOUT_MS } = getAnthropicEnv();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ANTHROPIC_REQUEST_TIMEOUT_MS);

      let response: Response;
      try {
        response = await deps.fetchFn('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: ANTHROPIC_VISION_MODEL,
            max_tokens: 2048,
            system: SYSTEM_PROMPT,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: input.mimeType, data: input.imageBase64 } },
                  { type: 'text', text: USER_PROMPT },
                ],
              },
            ],
            tools: [FOOD_DETECTION_TOOL],
            tool_choice: { type: 'tool', name: TOOL_NAME },
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw new ApiRouteError('ai_provider_error', `AI vision request timed out after ${ANTHROPIC_REQUEST_TIMEOUT_MS}ms.`);
        }
        throw new ApiRouteError('ai_provider_error', 'Could not reach the AI vision provider.');
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // Read a short, sanitized snippet of the provider's own error
        // body for debuggability — this is Anthropic's error text, never
        // anything containing the request's image data.
        let bodyText = '';
        try {
          bodyText = (await response.text()).slice(0, 300);
        } catch {
          // ignore — body isn't essential to the error message
        }
        throw new ApiRouteError('ai_provider_error', `AI vision provider returned status ${response.status}. ${bodyText}`);
      }

      let data: AnthropicMessageResponse;
      try {
        data = (await response.json()) as AnthropicMessageResponse;
      } catch {
        throw new ApiRouteError('ai_provider_error', 'AI vision provider returned malformed JSON.');
      }

      const toolUseBlock = data.content?.find((block) => block.type === 'tool_use' && block.name === TOOL_NAME);
      if (!toolUseBlock) {
        throw new ApiRouteError('ai_provider_error', 'AI vision provider did not return the expected structured output.');
      }

      return parseAiVisionResponse(toolUseBlock.input, ANTHROPIC_VISION_MODEL);
    },
  };
}
