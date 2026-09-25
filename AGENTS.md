# Firebase Cloud Functions, not Next.js

This repo used to be a Next.js app deployed on Vercel. It's now a Firebase Cloud Functions (v2,
TypeScript) backend for the same product — see `functions/src/index.ts` for the four HTTPS entry
points. Business logic under `functions/src/services/` is framework-agnostic and was ported over
unchanged; only `functions/src/lib/auth.ts`, `apiResponse.ts`, and `validation.ts` are
Express/Cloud-Functions specific.

Local dev: `cd functions && npm install && npm run build`, then `firebase emulators:start`.
Deploy: `firebase deploy --only functions` from the repo root (needs `firebase.json`/`.firebaserc`
there). Secrets (`ANTHROPIC_API_KEY`, `USDA_FDC_API_KEY`, `REVENUECAT_SECRET_API_KEY`) live in
Firebase Secret Manager, not env files — see `functions/.env.example` for the full rundown.
