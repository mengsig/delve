import { describe, expect, it, vi } from 'vitest';
import { documentSchema } from '../reader/document';
import { depthGuide, formatAnswerFeedback, highDepthIssue, withPlainLanguageRetry } from './language';

const lesson = (blocks: unknown[], source?: string) => documentSchema.parse({ schema: 'delve.lesson/1', blocks, source });

describe('high depth language', () => {
  it('gives distinct guidance for the three levels', () => {
    expect(depthGuide.high).toMatch(/everyday words/i);
    expect(depthGuide.high).toMatch(/analogy or worked example/i);
    expect(depthGuide.medium).toMatch(/module or technique/i);
    expect(depthGuide.low).toMatch(/excerpts.*files and functions/i);
  });

  it('accepts readable blocks without treating structured metadata as prose', () => {
    const doc = lesson([
      { type: 'prose', heading: 'A safer handoff', text: 'A fresh claim keeps an old result from taking over.' },
      { type: 'environment', fallback: 'Try handing the work to a new helper.', runtime: 'delve.env/1', pack: 'lease-handoff@1',
        config: { pack: 'lease-handoff@1', parameters: { taskId: 'test_id', initialGeneration: 7, deadlineTicks: 3 } } },
      { type: 'check', kind: 'prediction', prompt: 'What happens next?', options: ['The old result wins', 'The new result wins'], expected: 1 },
    ], 'src/internal_file.ts');
    expect(highDepthIssue(doc, ['The new helper has the current claim.'])).toBeNull();
  });

  it.each([
    ['a long sentence', Array(31).fill('word').join(' ') + '.'],
    ['an identifier', 'The activeGeneration controls the handoff.'],
    ['a file', 'Look in src/worker.ts for the handoff.'],
    ['inline code', 'Use `claim` to decide.'],
    ['a source caveat', 'I cannot inspect the source files.'],
    ['a CI caveat', 'CI was not run.'],
    ['a diff caveat', 'The supplied diff is partial.'],
    ['a harness verdict', 'The benchmark harness passed after two CI retries.'],
  ])('flags %s in visible text', (_label, text) => {
    expect(highDepthIssue(lesson([{ type: 'prose', heading: 'Handoff', text }]))).not.toBeNull();
  });

  it('regenerates an unreadable response once, then surfaces any remaining failure', async () => {
    const clunky = lesson([{ type: 'prose', heading: 'Release', text: 'The old activeGeneration is removed.' }]);
    const plain = lesson([{ type: 'analogy', heading: 'A fresh claim', text: 'It works like taking a new number at the shop.' }]);
    const generate = vi.fn().mockResolvedValueOnce(clunky).mockResolvedValueOnce(plain);
    await expect(withPlainLanguageRetry(generate, highDepthIssue)).resolves.toEqual(plain);
    expect(generate).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => clunky);
    await expect(withPlainLanguageRetry(failing, highDepthIssue)).rejects.toMatchObject({ code: 'UNREADABLE_TUTOR_REPLY' });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('checks all visible fields and feedback but ignores hidden answers', () => {
    const doc = lesson([{ type: 'check', kind: 'short-answer', prompt: 'What happens?', expected: ['internal_field'] }]);
    expect(highDepthIssue(doc)).toBeNull();
    expect(highDepthIssue(doc, ['Check internal_field.'])).not.toBeNull();
    expect(highDepthIssue(lesson([{ type: 'example', heading: 'Example', setup: 'A worker starts.', steps: ['Use worker_id.'], takeaway: 'It finishes.' }]))).not.toBeNull();
    expect(highDepthIssue(lesson([{ type: 'code', source: 'src/file.ts', lines: ['const x = 1;'] }]))).not.toBeNull();
  });
});

describe('answer feedback', () => {
  it('uses the trusted choice result and includes reasoning feedback', () => {
    expect(formatAnswerFeedback(true, 'The fresh claim wins.', 'Your reasoning is incorrect. The old claim expired.'))
      .toBe('Partly right — The fresh claim wins. Your reasoning is incorrect.');
    expect(formatAnswerFeedback(false, 'The old claim expired.', 'Partly right: the timing matters.'))
      .toBe('Not quite — The old claim expired. the timing matters.');
    expect(formatAnswerFeedback(true, 'The fresh claim wins.', 'An expired claim cannot authorize a write.'))
      .toBe('Right — The fresh claim wins. An expired claim cannot authorize a write.');
  });

  it('removes duplicated verdicts and limits feedback to three sentences', () => {
    expect(formatAnswerFeedback(true, 'Right — First. Second. Third. Fourth.', 'Your reasoning is wrong. More detail.'))
      .toBe('Partly right — First. Second. Your reasoning is wrong.');
    expect(formatAnswerFeedback(false, 'First. Second. Third. Fourth.')).toBe('Not quite — First. Second. Third.');
    expect(() => formatAnswerFeedback(true, '  ')).toThrow();
  });
});
