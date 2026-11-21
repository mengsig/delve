import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkExit, extractClaudePayload, extractCodexPayload } from './output';
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

it('keeps unknown CLI diagnostics out of learner-facing failures', () => {
  const stderr = 'private process output';
  const failed = () => checkExit('codex', { code: 1, stdout: '', stderr });
  expect(failed).toThrow(/Try again/);
  expect(failed).not.toThrow(stderr);
  const envelope = JSON.stringify({ is_error: true, result: stderr });
  expect(() => extractClaudePayload({ code: 0, stdout: envelope, stderr })).toThrow(/choose another provider/);
  expect(() => extractClaudePayload({ code: 0, stdout: envelope, stderr })).not.toThrow(stderr);
});
