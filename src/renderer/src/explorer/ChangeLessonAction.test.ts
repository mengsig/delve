import { Children, isValidElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChangeLessonAction } from './ChangeLessonAction';
import type { LessonState } from './useChangeLesson';

function teachAction(node: ReactNode): (() => void) | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(child)) continue;
    if (typeof child.type === 'function' && child.type.name === 'TeachButton') return child.props.onClick;
    const found = teachAction(child.props.children);
    if (found) return found;
  }
}

describe('saved change entry', () => {
  it.each([['codex', 11], ['claude', 22]] as const)('opens the selected %s brief at the same depth', (provider, lessonId) => {
    const onLesson = vi.fn();
    const lesson = { brief: { conceptId: 7, lessonId }, running: false, review: { result: { status: 'idle' } },
      saved: { result: { status: 'ready' } }, approval: { allowed: false }, provider, canPrepare: false } as unknown as LessonState;
    const view = ChangeLessonAction({ lesson, depth: 'medium', onLesson, onRefreshDetails: vi.fn(), checkingDetails: false });
    const click = teachAction(view);
    expect(click).toBeTypeOf('function');
    click!();
    expect(onLesson).toHaveBeenCalledWith(7, lessonId);
  });
});
