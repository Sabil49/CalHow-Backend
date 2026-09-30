import { describe, expect, it } from 'vitest';
import { assertPro } from '../requirePro';

describe('assertPro', () => {
  it('passes for a Pro entitlement', async () => {
    await expect(assertPro('uid', async () => 'pro')).resolves.toBeUndefined();
  });

  it('rejects free users with pro_required', async () => {
    await expect(assertPro('uid', async () => 'free')).rejects.toMatchObject({ code: 'pro_required' });
  });
});
