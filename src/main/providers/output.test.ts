import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCodexPayload } from './output';
import { makeTempDir } from './test-helpers';

describe('extractCodexPayload', () => {
  it('parses a final message within the cap', async () => {
    const file = path.join(await makeTempDir('last'), 'last.json');
    await writeFile(file, '{"answer":"42"}');
    await expect(extractCodexPayload(file, 15)).resolves.toEqual({ answer: '42' });
  });

  it('refuses a final message larger than the cap without parsing it', async () => {
    const file = path.join(await makeTempDir('last'), 'last.json');
    await writeFile(file, `{"answer":"${'x'.repeat(4096)}"}`);
    await expect(extractCodexPayload(file, 1024)).rejects.toMatchObject({ code: 'PROVIDER_FAILED', message: expect.stringMatching(/exceeded 1024 bytes/) });
  });

  it('reports a missing final message as invalid output', async () => {
    const file = path.join(await makeTempDir('last'), 'missing.json');
    await expect(extractCodexPayload(file, 1024)).rejects.toMatchObject({ code: 'PROVIDER_INVALID_OUTPUT' });
  });
});
