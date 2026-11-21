import { z } from 'zod';
import { LAB_LIFETIME_MS, LAB_ACTION_LIMIT } from '../../../shared/lab-ipc';

const packet = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready'), session: z.string() }),
  z.strictObject({ kind: z.literal('failed'), session: z.string(), reason: z.string().min(1).max(160) }),
  z.strictObject({ kind: z.literal('layout'), session: z.string(), height: z.int().min(80).max(1600) }),
  z.strictObject({ kind: z.literal('input'), session: z.string(), seq: z.int().positive(), input: z.unknown() }),
]);

export class StageChannel {
  private interval = 0;
  private rate = 0;
  private bytes = 0;
  private sequence = 0;
  private ready = false;

  constructor(private session: string, private start: number) {}

  read(raw: unknown, now: number) {
    if (now >= this.start + LAB_LIFETIME_MS) throw new Error('This instrument session expired.');
    if (now - this.interval >= 1000) { this.interval = now; this.rate = 0; }
    if (++this.rate > 48) throw new Error('The instrument exceeded its message rate.');
    if (typeof raw !== 'string') return null;
    this.bytes += raw.length * 2;
    if (raw.length > 1024 || this.bytes > 256 * 1024) throw new Error('The instrument exceeded its output limit.');
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { return null; }
    const result = packet.safeParse(decoded);
    if (!result.success || result.data.session !== this.session) return null;
    const message = result.data;
    if (message.kind === 'ready') {
      if (this.ready) return null;
      this.ready = true;
    } else if (!this.ready) return null;
    if (message.kind === 'input') {
      if (message.seq !== this.sequence + 1) return null;
      if (++this.sequence > LAB_ACTION_LIMIT) throw new Error('The instrument reached its action limit.');
    }
    return message;
  }
}
