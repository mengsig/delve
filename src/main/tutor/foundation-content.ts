import { z } from 'zod';
import { freshCheckSchema } from '../reader/document';
import { highDepthTextIssue } from './language';

const short = z.string().trim().min(1).max(300);
const question = freshCheckSchema.safeExtend({ prompt: short, options: z.array(short).length(4) });
export const foundationSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,149}$/).refine(key => !/^(ws|change|demo)\//.test(key)),
  title: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(600),
  why: short,
  probe: question,
  practice: question,
}).refine(({ probe, practice }) => probe.prompt.toLowerCase() !== practice.prompt.toLowerCase(),
  'Use different situations to check and practise a foundation.');

export const foundationsSchema = z.array(foundationSchema).max(4);
export type Foundation = z.infer<typeof foundationSchema>;
export const foundationsJsonSchema = z.toJSONSchema(foundationsSchema, { target: 'draft-7', override: ({ jsonSchema }) => {
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'pattern']) delete jsonSchema[key];
  if (typeof jsonSchema.const === 'string') {
    jsonSchema.enum = [jsonSchema.const];
    delete jsonSchema.const;
  }
} });
delete foundationsJsonSchema.$schema;

export const foundationInstructions = [
  'For an opening topic or change, identify the 2–4 ideas a learner needs first. Include only essential foundations. Return an empty foundations list for self-contained material.',
  'Each foundation needs a stable transferable key, a plain title, a short standalone explanation with a concrete example in summary, and one sentence in why explaining how it helps with the main subject. The why sentence must not give away the answer to the probe.',
  'Reuse a matching key or title from the learner context. Include already known essentials so their graph links stay visible. Order the most basic ideas first.',
  'For probe and practice, write separate short prediction checks at the chosen depth. Use type check, kind prediction, four distinct choices and a zero-based expected index. Give no hints in the probe. In practice, apply the explanation to a new situation.',
  'Delve asks the probe before showing the explanation, and skips checks the learner has already covered. Build the main explanation on the foundations explicitly with brief reminders of the ideas you use, so it also works if the learner skips practice.',
].join('\n');

export function foundationLanguageIssue(foundations: readonly Foundation[]): string | null {
  return highDepthTextIssue(foundations.flatMap(({ title, why, summary, probe, practice }) =>
    [title, why, summary, probe.prompt, ...probe.options, practice.prompt, ...practice.options]));
}
