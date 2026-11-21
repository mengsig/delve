import { z } from 'zod';

export const assessmentSchema = z.strictObject({
  status: z.enum(['practice', 'partial', 'demonstrated']),
  observation: z.string().trim().min(1).max(1500),
  action: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1500),
  targetKey: z.string().min(1).max(1024).optional(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
