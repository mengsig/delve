import { describe, expect, it } from 'vitest';
import { environHasMarker, MARKER_VAR, parseProcStatPpid, parsePsTable, parseWindowsTable, readProcessTable, selectTargets, windowsKillScript, type ProcessEntry } from './proctable';

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
  const posix = (pid: number, exitedMs: number | null = null) => ({ pid, startedMs: null, exitedMs });
  const windows = (pid: number, startedMs: number, exitedMs: number | null = null) => ({ pid, startedMs, exitedMs });
  const pids = (list: ProcessEntry[]) => list.map((e) => e.pid);

  it('collects marked processes and descendants of a live root, never the root itself', () => {
    const entries = [entry(1, 0), entry(100, 1), entry(101, 100), entry(102, 101), entry(200, 1, { marked: true }), entry(201, 200), entry(300, 1)];
    expect(pids(selectTargets(entries, posix(100)))).toEqual([101, 102, 200, 201]);
  });

  it('does not walk a POSIX root that has exited, since its pid may be reused', () => {
    const entries = [entry(100, 1), entry(101, 100), entry(200, 1, { marked: true })];
    expect(pids(selectTargets(entries, posix(100, 5_000)))).toEqual([200]);
  });

  it('follows Windows parent links only for children created during the parent lifetime', () => {
    const entries = [entry(101, 100, { startedMs: 1_500 }), entry(102, 101, { startedMs: 1_600 }), entry(103, 101, { startedMs: 1_400 }), entry(104, 100, { startedMs: 900 })];
    expect(pids(selectTargets(entries, windows(100, 1_000)))).toEqual([101, 102]);
  });

  it('ignores an unrelated process that reused the exited root pid, and its newer children', () => {
    const genuine = entry(101, 100, { startedMs: 1_500 });
    const reusedRoot = entry(100, 4, { startedMs: 3_000 });
    const unrelated = [entry(150, 100, { startedMs: 3_100 }), entry(151, 150, { startedMs: 3_200 })];
    expect(pids(selectTargets([genuine, reusedRoot, ...unrelated], windows(100, 1_000, 2_000)))).toEqual([101]);
  });

  it('terminates on parent cycles and rejects an invalid origin', () => {
    expect(pids(selectTargets([entry(5, 6), entry(6, 5)], posix(5)))).toEqual([6]);
    expect(() => selectTargets([], posix(0))).toThrow();
    expect(() => selectTargets([], windows(5, 2_000, 1_000))).toThrow();
  });
});

describe('windowsKillScript', () => {
  it('kills each target only when its start time still matches', () => {
    const script = windowsKillScript([entry(101, 100, { startedMs: 1_500 }), entry(102, 101, { startedMs: 1_600 })]);
    expect(script).toContain("@('101:1500','102:1600')");
    expect(script).toContain('-ne $ms) { continue }');
    expect(windowsKillScript([entry(7, 1, { startedMs: 9 })])).toContain("@('7:9')");
  });

  it('refuses targets without an identity', () => {
    expect(() => windowsKillScript([entry(101, 100)])).toThrow(/creation time/);
    expect(() => windowsKillScript([])).toThrow();
  });
});

describe('readProcessTable', () => {
  it('sees this process and finds a marker only when present', async () => {
    const table = await readProcessTable('no-such-marker');
    expect(table.some((e) => e.pid === process.pid)).toBe(true);
    expect(table.some((e) => e.marked)).toBe(false);
  });
});
