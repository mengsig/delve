import { useCallback, useRef, useState } from 'react';
import { z } from 'zod';
import { DEPTHS } from '../../shared/domain';

const base = z.object({ workspaceId: z.string().min(1), title: z.string().min(1), depth: z.enum(DEPTHS) });
const concept = base.extend({ conceptId: z.number().int().positive() });
const reference = z.object({ kind: z.enum(['pr', 'commit']), ref: z.string().min(1) });
const activity = z.discriminatedUnion('kind', [
  concept.extend({ kind: z.literal('lesson'), change: reference.optional() }),
  concept.extend({ kind: z.literal('environment'), blockKey: z.string().regex(/^(opening|\d+)\/\d+$/), change: reference.optional() }),
  base.extend({ kind: z.literal('change'), change: reference }),
]);

export type Activity = z.infer<typeof activity>;
const storageKey = 'delve.recent-activity';
const limit = 32;

function readActivity(): Activity[] {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return [];
  try {
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return [];
    return stored.slice(0, limit).flatMap(entry => {
      const result = activity.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  } catch (failure) {
    if (failure instanceof SyntaxError) return [];
    throw failure;
  }
}

export function activityKey(entry: Activity): string {
  const address: (string | number)[] = entry.kind === 'change' ? [entry.change.kind, entry.change.ref] : [entry.conceptId];
  if (entry.kind === 'environment') address.push(entry.blockKey);
  return JSON.stringify([entry.workspaceId, entry.kind, ...address]);
}

export function useRecentActivity() {
  const [recent, setRecent] = useState(readActivity);
  const current = useRef(recent);
  const remember = useCallback((entry: Activity) => {
    const previous = current.current;
    if (JSON.stringify(previous[0]) === JSON.stringify(entry)) return;
    const key = activityKey(entry);
    const next = [entry, ...previous.filter(item => activityKey(item) !== key)].slice(0, limit);
    localStorage.setItem(storageKey, JSON.stringify(next));
    current.current = next;
    setRecent(next);
  }, []);
  return { recent, remember };
}
