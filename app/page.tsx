/**
 * This project is an API-only backend for the CalHow mobile app — there is
 * no user-facing UI. This root page exists only so `next build`/`next dev`
 * have a valid `/` route; it's not part of the product surface.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: 'monospace', padding: 24 }}>
      <h1>CalHow API</h1>
      <p>This is a backend-only service. See /api/meals/* for endpoints.</p>
    </main>
  );
}
