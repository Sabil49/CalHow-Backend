import { config } from 'dotenv';
import path from 'path';

config({ path: path.join(__dirname, '..', '.env.local') });

import { getAdminAuth, getAdminFirestore } from '../lib/firebaseAdmin';
import { Timestamp } from 'firebase-admin/firestore';

/**
 * One-off script to create (or reset) an App Store review demo account
 * with realistic seeded data, so reviewers land on a populated app
 * instead of an empty-state one without needing to scan real food photos.
 *
 * Run with: npx tsx scripts/seedDemoAccount.ts
 * Requires calhow-backend/.env.local to have the Firebase Admin credentials.
 *
 * Deliberately self-contained (no import from calhow-mobile/types) — this
 * file is typechecked as part of this repo's own `next build`, which runs
 * in environments where the sibling calhow-mobile repo isn't checked out.
 */

type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

interface FoodItem {
  id: string;
  name: string;
  portionLabel: string;
  calories: number;
  confidence?: number;
}

const DEMO_EMAIL = 'md.sabeel10+applereview@gmail.com';
const DEMO_PASSWORD = 'CalHowDemo!25';
const DEMO_NAME = 'CalHow Reviewer';

async function getOrCreateUser(): Promise<string> {
  const auth = getAdminAuth();
  try {
    const existing = await auth.getUserByEmail(DEMO_EMAIL);
    await auth.updateUser(existing.uid, { password: DEMO_PASSWORD, displayName: DEMO_NAME });
    console.log(`Reusing existing demo account: ${existing.uid}`);
    return existing.uid;
  } catch {
    const created = await auth.createUser({
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      displayName: DEMO_NAME,
      emailVerified: true,
    });
    console.log(`Created demo account: ${created.uid}`);
    return created.uid;
  }
}

function daysAgo(n: number, hour = 8, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function seedProfile(uid: string) {
  const db = getAdminFirestore();
  const profile = {
    email: DEMO_EMAIL,
    fullName: DEMO_NAME,
    photoUrl: null,
    gender: 'prefer_not_to_say',
    dateOfBirth: '1994-06-15',
    heightCm: 175,
    currentWeightKg: 78.4,
    preferredUnit: 'metric',
    goals: {
      goalType: 'lose_weight',
      activityLevel: 'light',
      targetWeightKg: 72,
      weeklyPaceKg: 0.4,
      dailyCalorieTarget: 2100,
      macroTargets: { proteinG: 140, carbsG: 210, fatsG: 70, fiberG: 30 },
    },
    dietaryPreferences: { dietType: 'none', allergies: [], dislikedIngredients: [] },
    reminders: {
      mealRemindersEnabled: false,
      weightReminderEnabled: false,
    },
    onboardingComplete: true,
    subscription: { tier: 'free' },
    streakDays: 6,
    memberSince: Timestamp.fromDate(daysAgo(21)),
    createdAt: Timestamp.fromDate(daysAgo(21)),
    updatedAt: Timestamp.now(),
  };
  await db.collection('users').doc(uid).set(profile, { merge: true });
  console.log('Profile seeded.');
}

function makeMeal(
  userId: string,
  mealType: MealType,
  loggedAt: Date,
  foods: { name: string; portionLabel: string; calories: number }[],
  macros: { protein: number; carbs: number; fats: number; fiber?: number },
) {
  const totalCalories = foods.reduce((sum, f) => sum + f.calories, 0);
  const foodItems: FoodItem[] = foods.map((f, i) => ({
    id: `seed-${loggedAt.getTime()}-${i}`,
    name: f.name,
    portionLabel: f.portionLabel,
    calories: f.calories,
    confidence: 0.9,
  }));
  return {
    userId,
    mealType,
    calories: totalCalories,
    protein: macros.protein,
    carbs: macros.carbs,
    fats: macros.fats,
    fiber: macros.fiber,
    foods: foodItems,
    aiPrediction: {
      foods: foodItems,
      calories: totalCalories,
      protein: macros.protein,
      carbs: macros.carbs,
      fats: macros.fats,
      fiber: macros.fiber,
      confidence: 0.9,
      modelVersion: 'seed-data',
      analyzedAt: loggedAt.toISOString(),
    },
    isSaved: true,
    loggedAt,
  };
}

async function seedMeals(uid: string) {
  const db = getAdminFirestore();
  const meals = [
    makeMeal(uid, 'breakfast', daysAgo(0, 8, 15), [
      { name: 'Scrambled eggs', portionLabel: '2 eggs', calories: 180 },
      { name: 'Whole wheat toast', portionLabel: '2 slices', calories: 140 },
      { name: 'Avocado', portionLabel: '1/2 fruit (70 g)', calories: 120 },
    ], { protein: 24, carbs: 32, fats: 20, fiber: 7 }),
    makeMeal(uid, 'lunch', daysAgo(0, 13, 0), [
      { name: 'Grilled chicken breast', portionLabel: '150 g', calories: 250 },
      { name: 'Brown rice', portionLabel: '1 cup (195 g)', calories: 215 },
      { name: 'Steamed broccoli', portionLabel: '1 cup (90 g)', calories: 55 },
    ], { protein: 42, carbs: 45, fats: 6, fiber: 5 }),
    makeMeal(uid, 'dinner', daysAgo(1, 19, 30), [
      { name: 'Baked salmon', portionLabel: '180 g', calories: 340 },
      { name: 'Roasted sweet potato', portionLabel: '1 medium (150 g)', calories: 130 },
      { name: 'Mixed green salad', portionLabel: '1 bowl', calories: 60 },
    ], { protein: 36, carbs: 30, fats: 18, fiber: 6 }),
    makeMeal(uid, 'snack', daysAgo(1, 16, 0), [
      { name: 'Greek yogurt', portionLabel: '1 cup (245 g)', calories: 150 },
      { name: 'Mixed berries', portionLabel: '1/2 cup (75 g)', calories: 40 },
    ], { protein: 15, carbs: 20, fats: 3, fiber: 3 }),
    makeMeal(uid, 'breakfast', daysAgo(2, 8, 0), [
      { name: 'Oatmeal', portionLabel: '1 cup cooked (235 g)', calories: 160 },
      { name: 'Banana', portionLabel: '1 medium', calories: 105 },
      { name: 'Peanut butter', portionLabel: '1 tbsp', calories: 95 },
    ], { protein: 12, carbs: 52, fats: 12, fiber: 6 }),
    makeMeal(uid, 'lunch', daysAgo(3, 12, 45), [
      { name: 'Turkey sandwich', portionLabel: '1 sandwich', calories: 380 },
      { name: 'Apple', portionLabel: '1 medium', calories: 95 },
    ], { protein: 28, carbs: 48, fats: 12, fiber: 5 }),
    makeMeal(uid, 'dinner', daysAgo(4, 19, 0), [
      { name: 'Beef stir-fry', portionLabel: '1 bowl (350 g)', calories: 420 },
      { name: 'Jasmine rice', portionLabel: '3/4 cup (145 g)', calories: 160 },
    ], { protein: 34, carbs: 50, fats: 16, fiber: 3 }),
  ];

  const batch = db.batch();
  for (const meal of meals) {
    const ref = db.collection('users').doc(uid).collection('meals').doc();
    batch.set(ref, {
      ...meal,
      loggedAt: Timestamp.fromDate(meal.loggedAt),
      createdAt: Timestamp.fromDate(meal.loggedAt),
      updatedAt: Timestamp.fromDate(meal.loggedAt),
    });
  }
  await batch.commit();
  console.log(`${meals.length} meals seeded.`);
}

async function seedWeightLogs(uid: string) {
  const db = getAdminFirestore();
  const entries: { weightKg: number; daysBack: number }[] = [
    { weightKg: 81.2, daysBack: 20 },
    { weightKg: 80.5, daysBack: 16 },
    { weightKg: 80.1, daysBack: 12 },
    { weightKg: 79.3, daysBack: 8 },
    { weightKg: 78.8, daysBack: 4 },
    { weightKg: 78.4, daysBack: 0 },
  ];

  const batch = db.batch();
  for (const entry of entries) {
    const loggedAt = daysAgo(entry.daysBack, 7, 30);
    const ref = db.collection('users').doc(uid).collection('weightLogs').doc();
    batch.set(ref, {
      userId: uid,
      weightKg: entry.weightKg,
      loggedAt: Timestamp.fromDate(loggedAt),
      createdAt: Timestamp.fromDate(loggedAt),
    });
  }
  await batch.commit();
  console.log(`${entries.length} weight logs seeded.`);
}

async function main() {
  const uid = await getOrCreateUser();
  await seedProfile(uid);
  await seedMeals(uid);
  await seedWeightLogs(uid);
  console.log('\nDemo account ready:');
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`  UID:      ${uid}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
