import { useCallback, useEffect, useEffectEvent, useRef } from 'react';
import type { LessonAddress, ReaderLesson, TutorIntent, TutorRequest } from '../../../shared/reader';
import { call } from '../api';
import { useRead } from '../useRead';
import type { LessonTutor } from './Tutor';
import { hasTutorApproval } from './tutorApproval';
import { lessonKey, useTutorJobs } from './TutorJobs';
import { ExactRequest, PreviewMetadata } from './TutorPreview';

export function openingIntent(body: ReaderLesson): TutorIntent | null {
  if (body.invalidLatest) return null;
  if (body.mastery.needsAdaptation && body.mastery.revision) return { kind: 'adapt', revision: body.mastery.revision };
  if (!body.reused && !body.revision && !body.blocks.length) return { kind: 'teach' };
  if (body.mastery.stage === 'teaching' && body.mastery.revision) return { kind: 'review', revision: body.mastery.revision };
  return null;
}

export function useOpenLesson(body: ReaderLesson, tutor: LessonTutor, review = false) {
  const attempted = useRef('');
  const reviewed = useRef(false);
  const intent = review && body.mastery.stage === 'understood' && body.mastery.revision
    ? { kind: 'review' as const, revision: body.mastery.revision } : openingIntent(body);
  const key = intent && [tutor.provider, intent.kind, body.mastery.revision].join('/');
  const ready = tutor.signedIn && !tutor.pending && !tutor.job && !tutor.review.preview;
  const prepare = useEffectEvent(() => {
    if (!intent || !key || attempted.current === key) return;
    if (review && intent.kind === 'review') {
      if (reviewed.current) return;
      reviewed.current = true;
    }
    attempted.current = key;
    tutor.prepare(intent, review && intent.kind === 'review');
  });
  useEffect(() => {
    if (!ready || !key) return;
    const timer = window.setTimeout(prepare, 0);
    return () => window.clearTimeout(timer);
  }, [key, ready]);
  return intent;
}

interface StartProps extends LessonAddress {
  title: string;
  provider: TutorRequest['provider'];
  open: (id: number) => void;
}

export function LessonStart({ title, open, workspaceId, conceptId, depth, provider }: StartProps) {
  const queue = useTutorJobs();
  const query = useCallback(async () => {
    const address = { workspaceId, conceptId, depth };
    const lesson = await call('reader:lesson', address);
    const intent = openingIntent(lesson);
    if (!intent) return null;
    const request = { ...address, provider, intent };
    return { request, data: await call('tutor:preview', request) };
  }, [workspaceId, conceptId, depth, provider]);
  const { result, refresh } = useRead(query);
  if (result.status === 'error') return <div role="alert">{result.message} <button onClick={refresh}>Retry next lesson</button></div>;
  const prepared = result.status === 'ready' && result.value;
  const running = queue.jobs.get(lessonKey({ workspaceId, conceptId, depth }));
  const active = running?.phase === 'running' || running?.phase === 'cancelling';
  const consent = prepared && !active && provider !== 'demo' && !hasTutorApproval(workspaceId, provider);
  function start() {
    if (result.status !== 'ready') return;
    if (prepared && !active) queue.start({ request: prepared.request, token: prepared.data.token, title });
    open(conceptId);
  }
  return <div className="next-start">
    {consent && <div className="next-preview"><PreviewMetadata provider={provider} data={prepared.data} />
      <ExactRequest data={prepared.data} /></div>}
    <button className="primary-btn" disabled={result.status === 'loading'} onClick={start}>
      {consent ? 'Allow once & start ' : 'Start '}{title} <span aria-hidden="true">→</span></button>
  </div>;
}
