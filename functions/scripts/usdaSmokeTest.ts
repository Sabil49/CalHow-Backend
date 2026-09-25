/**
 * Live USDA FoodData Central smoke test.
 *
 * This hits the REAL USDA API — it cannot be run in the sandbox this
 * project was built in (network egress to api.nal.usda.gov is blocked
 * there). Run this on your own machine after setting a real
 * USDA_FDC_API_KEY. See the "How to run" section in the project report
 * for the exact steps.
 *
 * Never logs the API key itself — only whether it's present.
 */
import { config } from 'dotenv';
config({ path: '.env' });

import { lookupUsdaMatchWithMetadata } from '../src/services/nutrition/usda/usdaNutritionLookupProvider';
import { normalizeFoodDescription } from '../src/services/foodMatching/normalizer';
import type { NormalizerInput } from '../src/types/nutrition';

const TEST_FOODS: NormalizerInput[] = [
  { rawName: 'grilled chicken breast', estimatedPortionGrams: 150 },
  { rawName: 'cooked white rice', estimatedPortionGrams: 200 },
  { rawName: 'avocado', estimatedPortionGrams: 100 },
  { rawName: 'olive oil', estimatedPortionGrams: 10 },
  { rawName: 'boiled egg', estimatedPortionGrams: 50 },
];

async function main() {
  if (!process.env.USDA_FDC_API_KEY) {
    console.error(
      'USDA_FDC_API_KEY is not set.\n' +
        'Copy .env.example to .env and fill in a real key from https://fdc.nal.usda.gov/api-key-signup.html, then re-run.',
    );
    process.exitCode = 1;
    return;
  }

  console.log('USDA FoodData Central — live smoke test\n' + '='.repeat(60));

  let failures = 0;

  for (const food of TEST_FOODS) {
    const normalized = normalizeFoodDescription(food);
    console.log(`\nquery: "${food.rawName}"  (normalized: "${normalized.normalizedName}")`);
    try {
      const match = await lookupUsdaMatchWithMetadata(normalized.normalizedName);
      if (!match) {
        console.log('  RESULT: no confident match found');
        failures++;
        continue;
      }
      console.log(`  selected USDA description : ${match.description}`);
      console.log(`  fdcId                     : ${match.fdcId}`);
      console.log(`  dataType                  : ${match.dataType}`);
      console.log(`  match score               : ${match.score.toFixed(2)}`);
      console.log(`  calories/100g             : ${match.nutritionPer100g.caloriesPer100g}`);
      console.log(`  protein/100g              : ${match.nutritionPer100g.proteinPer100g}`);
      console.log(`  carbs/100g                : ${match.nutritionPer100g.carbsPer100g}`);
      console.log(`  fat/100g                  : ${match.nutritionPer100g.fatsPer100g}`);
      console.log(`  fiber/100g                : ${match.nutritionPer100g.fiberPer100g ?? '(not reported)'}`);
    } catch (err) {
      console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
      failures++;
    }
  }

  console.log('\n' + '='.repeat(60));
  if (failures > 0) {
    console.log(`${failures} of ${TEST_FOODS.length} lookups failed or found no match. Review output above.`);
    process.exitCode = 1;
  } else {
    console.log(`All ${TEST_FOODS.length} lookups succeeded.`);
  }
}

main();
