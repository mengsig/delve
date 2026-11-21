import { z } from 'zod';
import { packSchema } from './instruments';

export const bundleConfigSchema = z.strictObject({
  pack: z.literal('bundle@1'),
  bundle: z.strictObject({
    apiVersion: z.literal('delve.view/1'),
    entry: z.literal('step'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    source: z.string().min(1).max(32768),
  }),
  parameters: z.strictObject({
    title: z.string().trim().min(1).max(120),
    initial: z.string().max(2048),
  }),
});

export const labConfigSchema = z.union([packSchema, bundleConfigSchema]);
export type BundleConfig = z.infer<typeof bundleConfigSchema>;
export type LabConfig = z.infer<typeof labConfigSchema>;
