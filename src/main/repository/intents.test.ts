import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/connection';
import { addWorkspace, listWorkspaces } from '../db/workspaces';
import { LearnInbox, parseIntent } from './intents';

describe('external learn intents', () => {
  it.each(['commit=deadbeef', 'pr=184', 'proposed=design%2F145'])('accepts %s as data', query => {
    expect(parseIntent('delve://learn?workspace=octo/repo&' + query)).toMatchObject({ workspace: 'octo/repo' });
  });
  it.each(['file:///etc/passwd', 'delve://learn/x?workspace=a/b&pr=1', 'delve://learn?workspace=a/b&pr=1&commit=abc1234',
    'delve://learn?workspace=/tmp/repo&pr=2', 'delve://learn?workspace=a/b&commit=--help', 'delve://learn?workspace=a/b&pr=-1',
    'delve://evil@learn?workspace=a/b&pr=1', 'delve://learn?workspace=a/b&proposed=oops%0Acode'])('rejects malformed link %s', link => {
    expect(() => parseIntent(link)).toThrow();
  });
  it('imports only after consent, rejects stale decisions and reuses the chosen workspace', () => {
    const db = openDatabase(':memory:');
    try {
      const inbox = new LearnInbox();
      const link = 'delve://learn?workspace=octo/repo&pr=1';
      inbox.receive(link);
      const rejected = inbox.peek()!.id;
      expect(inbox.resolve(db, rejected, false)).toBeNull();
      expect(listWorkspaces(db).workspaces).toHaveLength(0);
      inbox.receive(link);
      expect(() => inbox.resolve(db, rejected, true)).toThrow(/handled/);
      const imported = inbox.resolve(db, inbox.peek()!.id, true)!;
      const other = addWorkspace(db, { kind: 'topic', title: 'Other' });
      inbox.receive('delve://learn?workspace=' + imported.id + '&commit=1a2b3c4');
      expect(listWorkspaces(db).activeId).toBe(other.id);
      expect(inbox.resolve(db, inbox.peek()!.id, true)?.id).toBe(imported.id);
      expect(listWorkspaces(db).workspaces).toHaveLength(2);
    } finally { db.close(); }
  });
});
