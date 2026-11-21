import { describe, expect, it } from 'vitest';
import { StageChannel } from './channel';
import { LAB_LIFETIME_MS } from '../../../shared/lab-ipc';

const session = 'b0ba3189-ef7a-4323-9c81-f4c35026d273';
const ready = JSON.stringify({ session, kind: 'ready' });
const action = (seq: number) => JSON.stringify({ session, kind: 'input', seq, input: { type: 'advance' } });

describe('private instrument port', () => {
  it('accepts inputs from one initialized session and ignores stale, duplicate and malformed packets', () => {
    const channel = new StageChannel(session, 0);
    expect(channel.read(action(1), 0)).toBeNull();
    expect(channel.read(ready, 1)?.kind).toBe('ready');
    for (const raw of [ready, action(1).replace(session, 'other'), action(2), 'not JSON', 42]) {
      expect(channel.read(raw, 2)).toBeNull();
    }
    expect(channel.read(action(1), 3)?.kind).toBe('input');
    expect(channel.read(action(1), 4)).toBeNull();
    expect(channel.read(action(2), 5)?.kind).toBe('input');
  });

  it('bounds individual output, lifetime, total output and total actions', () => {
    expect(() => new StageChannel(session, 0).read('x'.repeat(1025), 0)).toThrow(/output/);
    expect(() => new StageChannel(session, 0).read(ready, LAB_LIFETIME_MS)).toThrow(/expired/);
    const bytes = new StageChannel(session, 0);
    for (let i = 0; i < 128; i++) bytes.read('x'.repeat(1024), i * 1000);
    expect(() => bytes.read('x', 128000)).toThrow(/output/);
    const actions = new StageChannel(session, 0);
    actions.read(ready, 0);
    for (let seq = 1; seq <= 256; seq++) actions.read(action(seq), seq * 1000);
    expect(() => actions.read(action(257), 257000)).toThrow(/action limit/);
  });

  it('counts malformed packets toward the flood limit', () => {
    const channel = new StageChannel(session, 0);
    for (let i = 0; i < 48; i++) expect(channel.read('?', 3)).toBeNull();
    expect(() => channel.read(ready, 3)).toThrow(/rate/);
  });
});
