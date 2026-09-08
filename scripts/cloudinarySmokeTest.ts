/**
 * Live Cloudinary smoke test.
 *
 * Uploads a tiny real image through the actual
 * createCloudinaryImageStorageProvider() (the same code path
 * app/api/meals/image/route.ts uses) with your real CLOUDINARY_* env vars,
 * then fetches the returned URL back to confirm it's genuinely durable and
 * publicly reachable — not just that Cloudinary accepted the request.
 *
 * Never logs the API secret itself — only whether it's present.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { createCloudinaryImageStorageProvider } from '../services/media/cloudinaryImageStorageProvider';

// A minimal valid 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function main() {
  const required = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `Missing env var(s): ${missing.join(', ')}.\n` +
        'Set them in .env.local — see .env.example for where to get them (https://cloudinary.com/users/register/free).',
    );
    process.exitCode = 1;
    return;
  }

  console.log('Cloudinary — live smoke test\n' + '='.repeat(60));

  const provider = createCloudinaryImageStorageProvider();
  const testUid = 'smoke-test-uid';
  const testImageId = `smoke-test-${Date.now()}`;

  console.log(`\nuploading as calhow/users/${testUid}/meals/${testImageId} ...`);

  try {
    const result = await provider.upload({ imageBase64: TINY_PNG_BASE64, mimeType: 'image/png', uid: testUid, imageId: testImageId });
    console.log(`  upload OK`);
    console.log(`  url        : ${result.url}`);
    console.log(`  providerId : ${result.providerId}`);

    console.log('\nfetching the returned URL back to confirm it is publicly durable...');
    const fetchRes = await fetch(result.url);
    if (!fetchRes.ok) {
      console.error(`  FAILED — GET ${result.url} returned status ${fetchRes.status}`);
      process.exitCode = 1;
      return;
    }
    const contentType = fetchRes.headers.get('content-type');
    console.log(`  fetch OK — status ${fetchRes.status}, content-type ${contentType}`);

    console.log('\nre-uploading the SAME uid+imageId to confirm the idempotent overwrite:true path...');
    const result2 = await provider.upload({ imageBase64: TINY_PNG_BASE64, mimeType: 'image/png', uid: testUid, imageId: testImageId });
    if (result2.providerId !== result.providerId) {
      console.error(`  FAILED — retry produced a different providerId (${result2.providerId} vs ${result.providerId}), expected the same deterministic path`);
      process.exitCode = 1;
      return;
    }
    console.log(`  retry OK — same providerId (${result2.providerId}), idempotent as designed`);

    console.log('\n' + '='.repeat(60));
    console.log('All Cloudinary smoke checks passed.');
    console.log(`\nNote: a real test asset was left at ${result.url} (calhow/users/${testUid}/meals/${testImageId}).`);
    console.log('Delete it from your Cloudinary Media Library if you want to tidy up — no automated cleanup runs here.');
  } catch (err) {
    console.error(`  FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

main();
