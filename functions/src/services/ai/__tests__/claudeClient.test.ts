import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { callClaudeStructured } from '../claudeClient';

vi.mock('@/lib/env', () => ({ getAnthropicEnv: () => ({ ANTHROPIC_API_KEY: 'test' }) }));

const schema = z.object({ ok: z.boolean() });

function fakeClient(result: unknown) {
  const parse = typeof result === 'function' ? vi.fn().mockImplementation(result as () => unknown) : vi.fn().mockResolvedValue(result);
  return { client: { beta: { messages: { parse } } } as never, parse };
}

function call(model: string, client: never) {
  return callClaudeStructured(
    { model, system: 's', content: [{ type: 'text', text: 'hi' }], schema, maxTokens: 100, effort: 'low', timeoutMs: 1000 },
    client,
  );
}

describe('callClaudeStructured', () => {
  it('returns the parsed output', async () => {
    const { client } = fakeClient({ stop_reason: 'end_turn', parsed_output: { ok: true } });
    await expect(call('claude-opus-5-5', client)).resolves.toEqual({ ok: true });
  });

  it('opts into server-side fallbacks on models that support "default", and not otherwise', async () => {
    const opus = fakeClient({ stop_reason: 'end_turn', parsed_output: { ok: true } });
    await call('claude-opus-5-5', opus.client);
    expect(opus.parse.mock.calls[0]![0]).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });

    const sonnet = fakeClient({ stop_reason: 'end_turn', parsed_output: { ok: true } });
    await call('claude-sonnet-5', sonnet.client);
    expect(sonnet.parse.mock.calls[0]![0]).not.toHaveProperty('fallbacks');
    expect(sonnet.parse.mock.calls[0]![1]).toEqual({ timeout: 1000 });
  });

  it.each([
    ['a refusal', { stop_reason: 'refusal', parsed_output: null }],
    ['a truncated response', { stop_reason: 'max_tokens', parsed_output: null }],
    ['output that did not parse', { stop_reason: 'end_turn', parsed_output: null }],
  ])('turns %s into ai_provider_error', async (_label, result) => {
    const { client } = fakeClient(result);
    await expect(call('claude-opus-5-5', client)).rejects.toMatchObject({ code: 'ai_provider_error' });
  });

  it('turns a thrown error into ai_provider_error', async () => {
    const { client } = fakeClient(() => Promise.reject(new Error('socket hang up')));
    await expect(call('claude-opus-5-5', client)).rejects.toMatchObject({ code: 'ai_provider_error' });
  });
});
