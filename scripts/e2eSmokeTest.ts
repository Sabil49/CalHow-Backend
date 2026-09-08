/**
 * Live end-to-end smoke test for the AI + USDA pipeline.
 *
 * DEVELOPMENT-ONLY. This calls the REAL Anthropic API and the REAL USDA
 * FoodData Central API — not fixtures, not mocks. It exercises the exact
 * same `runAnalyzePipeline` function the `analyze` route handler calls,
 * so a clean run here is a genuine end-to-end confidence check on the
 * pipeline as it actually behaves in production, minus two things:
 *
 *   - It does NOT save anything to Firestore (no `createPendingAnalysis`
 *     call) — this script never touches Firebase Admin at all, so it
 *     doesn't need Firebase credentials, only ANTHROPIC_API_KEY and
 *     USDA_FDC_API_KEY.
 *   - It does NOT go through the Next.js route/auth layer — there's no
 *     Firebase ID token involved, since this runs locally, not as an
 *     HTTP request.
 *
 * NEVER PRINTED: API keys, Firebase Admin credentials, or raw base64
 * image data. Only presence/absence of required keys is logged, never
 * their values. Search this file for "NEVER" comments marking the
 * specific points this is enforced.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { getVisionProvider } from '../services/ai/visionProvider';
import { getNutritionLookupProvider } from '../services/nutrition/nutritionLookup';
import { runAnalyzePipeline } from '../services/analysis/analyzePipeline';
import { calculateFoodItemTotals } from '../services/nutrition/calculate';
import { ApiRouteError } from '../lib/apiResponse';
import type { FoodMatch } from '../types/nutrition';

const MAX_DIMENSION_PX = 1568; // a commonly-recommended cap for vision-model inputs — balances detail against payload size/token cost
const JPEG_QUALITY = 85;

function line(char = '=', width = 64): string {
  return char.repeat(width);
}

async function loadAndCompressImage(imagePath: string): Promise<{ base64: string; mimeType: 'image/jpeg'; originalBytes: number; compressedBytes: number }> {
  const absolutePath = path.resolve(imagePath);
  const originalBuffer = await readFile(absolutePath);

  const compressedBuffer = await sharp(originalBuffer)
    .rotate() // apply EXIF orientation before resizing, so a sideways phone photo doesn't get analyzed sideways
    .resize({ width: MAX_DIMENSION_PX, height: MAX_DIMENSION_PX, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return {
    // NEVER log/return this value anywhere except into the base64 field consumed directly by the vision provider call below.
    base64: compressedBuffer.toString('base64'),
    mimeType: 'image/jpeg',
    originalBytes: originalBuffer.byteLength,
    compressedBytes: compressedBuffer.byteLength,
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function printFoodMatch(detected: { rawName: string; preparationMethod?: string; estimatedPortionGrams?: number; estimatedPortionLabel?: string; detectionConfidence: number; uncertaintyTopics?: string[] }, match: FoodMatch) {
  console.log(`FOOD: ${detected.rawName}`);
  if (detected.preparationMethod) console.log(`  Preparation      : ${detected.preparationMethod}`);
  console.log(`  AI portion       : ${detected.estimatedPortionGrams ?? '(not given)'}g${detected.estimatedPortionLabel ? ` (${detected.estimatedPortionLabel})` : ''}`);
  console.log(`  AI confidence    : ${detected.detectionConfidence.toFixed(2)}`);
  console.log(`  Uncertainty      : ${detected.uncertaintyTopics?.length ? detected.uncertaintyTopics.join(', ') : '(none)'}`);

  if (!match.nutrition) {
    console.log('  USDA match       : NOT FOUND\n');
    return;
  }

  const totals = calculateFoodItemTotals(match.portionGrams, match.nutrition);
  console.log(`  USDA match       : ${match.nutrition.description}`);
  console.log(`  FDC ID           : ${match.nutrition.sourceId}`);
  console.log(`  Data type        : ${match.nutrition.dataType ?? '(unknown)'}`);
  console.log(`  Match score      : ${match.nutrition.matchScore?.toFixed(2) ?? '(n/a)'}`);
  console.log(`  Calories         : ${totals.calories}`);
  console.log(`  Protein          : ${totals.protein}g`);
  console.log(`  Carbs            : ${totals.carbs}g`);
  console.log(`  Fat              : ${totals.fats}g`);
  console.log(`  Fiber            : ${totals.fiber ?? '(not reported)'}g`);
  console.log('');
}

async function main() {
  const imagePathArg = process.argv[2];

  console.log(line());
  console.log('CalHow AI + USDA Pipeline — Live End-to-End Smoke Test');
  console.log(line());
  console.log('This calls the REAL Anthropic API and REAL USDA API. Nothing is mocked.');
  console.log('Nothing is written to Firestore.\n');

  // Fail clearly and immediately if either required key is missing —
  // before touching the network at all. NEVER print the key values
  // themselves, only whether each is present.
  const missing: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!process.env.USDA_FDC_API_KEY) missing.push('USDA_FDC_API_KEY');
  if (missing.length > 0) {
    console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
    console.error('Add them to .env.local (copy from .env.example) before running this script.');
    process.exitCode = 1;
    return;
  }

  if (!imagePathArg) {
    console.error('Usage: npm run smoke:e2e -- /path/to/meal-photo.jpg');
    process.exitCode = 1;
    return;
  }

  let image: Awaited<ReturnType<typeof loadAndCompressImage>>;
  try {
    image = await loadAndCompressImage(imagePathArg);
  } catch (err) {
    console.error(`Could not read/compress image at "${imagePathArg}": ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Image: ${path.resolve(imagePathArg)}`);
  console.log(`  Original size    : ${formatBytes(image.originalBytes)}`);
  console.log(`  Compressed size  : ${formatBytes(image.compressedBytes)} (resized to fit within ${MAX_DIMENSION_PX}px, JPEG q${JPEG_QUALITY})`);
  console.log('');

  let result: Awaited<ReturnType<typeof runAnalyzePipeline>>;
  try {
    // Real providers — NOT fixtures/mocks. getVisionProvider() returns
    // the Anthropic-backed implementation; getNutritionLookupProvider()
    // returns the USDA-backed implementation. Same factories the real
    // `analyze` route handler calls.
    result = await runAnalyzePipeline(
      { imageBase64: image.base64, mimeType: image.mimeType },
      { visionProvider: getVisionProvider(), lookupProvider: getNutritionLookupProvider() },
    );
  } catch (err) {
    console.log(line('-'));
    console.log('PIPELINE FAILED');
    console.log(line('-'));
    if (err instanceof ApiRouteError) {
      console.error(`[${err.code}] ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
    return;
  }

  console.log(line('-'));
  console.log('AI Vision Detections + USDA Matches');
  console.log(line('-'));
  console.log('');

  result.aiResult.detectedFoods.forEach((detected, index) => {
    const match = result.foodMatches[index];
    if (match) printFoodMatch(detected, match);
  });

  console.log(line('-'));
  console.log('TOTAL');
  console.log(line('-'));
  console.log(`Calories: ${result.prediction.calories}`);
  console.log(`Protein : ${result.prediction.protein}g`);
  console.log(`Carbs   : ${result.prediction.carbs}g`);
  console.log(`Fat     : ${result.prediction.fats}g`);
  console.log(`Fiber   : ${result.prediction.fiber ?? '(not reported)'}g`);
  console.log(`Overall confidence: ${result.prediction.confidence.toFixed(2)}`);
  console.log('');

  console.log(line('-'));
  const needsClarification = result.clarificationQuestions.length > 0;
  console.log(`Clarification required: ${needsClarification ? 'YES' : 'NO'}`);
  if (needsClarification) {
    for (const question of result.clarificationQuestions) {
      console.log(`  - ${question.question} (options: ${question.options.map((o) => o.label).join(', ')})`);
    }
  }
  console.log(line());
}

main();
