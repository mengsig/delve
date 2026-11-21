import { z } from 'zod';
import type { LabContract } from '../../shared/lab-ipc';
import { address } from '../reader/ipc';

const session = z.uuid();
export const labSchemas = {
  'lab:open': address.extend({ revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    messageId: z.int().positive().nullable(), blockIndex: z.int().min(0).max(79) }),
  'lab:input': z.strictObject({ session, seq: z.int().positive().max(100000), input: z.unknown() }),
  'lab:close': z.strictObject({ session }),
} satisfies { [C in keyof LabContract]: z.ZodType<LabContract[C]['request']> };
