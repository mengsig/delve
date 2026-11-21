import { describe, expect, it } from 'vitest';
import { environHasMarker, MARKER_VAR, parseProcStatPpid, parsePsTable, parseWindowsTable, readProcessTable, selectTargets, type ProcessEntry } from './proctable';

const entry = (pid: number, ppid: number, over: Partial<ProcessEntry> = {}): ProcessEntry => ({ pid, ppid, marked: false, startedMs: null, ...over });

describe('process table parsing', () => {
  it('reads the parent pid even when the command name has spaces and parentheses', () => {
    expect(parseProcStatPpid('4242 (node) S 17 4242 4242 0 -1')).toBe(17);
    expect(parseProcStatPpid('99 (weird ) name)) R 1 99 99 0')).toBe(1);
    expect(() => parseProcStatPpid('garbage')).toThrow();
  });

  it('matches the run marker only as a whole environment entry', () => {
    const environ = `HOME=/h\0${MARKER_VAR}=abc\0PATH=/bin\0`;
    expect(environHasMarker(environ, 'abc')).toBe(true);
    expect(environHasMarker(environ, 'ab')).toBe(false);
    expect(environHasMarker(`X=${MARKER_VAR}=abc-more\0`, 'abc')).toBe(false);
  });

  it('parses ps output with appended environments', () => {
    const text = `  10     1 /usr/bin/claude -p HOME=/h ${MARKER_VAR}=tok PATH=/bin\n  11    10 helper ${MARKER_VAR}=tok\n  12     1 other ${MARKER_VAR}=tok2\n`;
    expect(parsePsTable(text, 'tok')).toEqual([entry(10, 1, { marked: true }), entry(11, 10, { marked: true }), entry(12, 1)]);
  });

  it('parses the Windows query and rejects malformed lines', () => {
    expect(parseWindowsTable('4 0 0\r\n500 4 1700000000000\r\n\r\n')).toEqual([entry(4, 0), entry(500, 4, { startedMs: 1700000000000 })]);
    expect(() => parseWindowsTable('500 four 1')).toThrow(/unexpected process table line/);
  });
});

describe('selectTargets', () => {
  it('collects marked processes and descendants of the root, never the root itself', () => {
    const entries = [entry(1, 0), entry(100, 1), entry(101, 100), entry(102, 101), entry(200, 1, { marked: true }), entry(300, 1)];
    expect(selectTargets(entries, 100, 0)).toEqual([101, 102, 200]);
  });

  it('skips processes created before the run, so a reused parent pid is not followed', () => {
    const entries = [entry(100, 7, { startedMs: 5_000 }), entry(101, 100, { startedMs: 900 }), entry(102, 100, { startedMs: 6_000 })];
    expect(selectTargets(entries, 100, 4_000)).toEqual([102]);
  });

  it('terminates on parent cycles and rejects an invalid root', () => {
    expect(selectTargets([entry(5, 6), entry(6, 5)], 5, 0)).toEqual([6]);
    expect(() => selectTargets([], 0, 0)).toThrow();
  });
});

describe('readProcessTable', () => {
  it('sees this process and finds a marker only when present', async () => {
    const table = await readProcessTable('no-such-marker');
    expect(table.some((e) => e.pid === process.pid)).toBe(true);
    expect(table.some((e) => e.marked)).toBe(false);
  });
});
