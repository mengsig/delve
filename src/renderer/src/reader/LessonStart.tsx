import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { LessonAddress, ReaderLesson, TutorIntent, TutorRequest } from '../../../shared/reader';
import { call } from '../api';
import { useRead } from '../useRead';
import type { LessonTutor } from './Tutor';
import { hasTutorApproval } from './tutorApproval';
import { lessonKey, useTutorJobs } from './TutorJobs';
import { ExactRequest, PreviewMetadata } from './TutorPreview';

export function LessonRecovery({ body, tutor }: {
  body: Pick<ReaderLesson, 'invalidLatest' | 'revision' | 'mastery'>;
  tutor: Pick<LessonTutor, 'pending' | 'signedIn' | 'provider' | 'prepare'>;
}) {
  if (!body.invalidLatest || (!body.revision && body.mastery.stage !== 'understood')) return null;
  const disabled = tutor.pending || !tutor.signedIn;
  return <section className="reader-notice" role="status">
    <p>{body.revision ? 'The newest lesson could not be displayed. You can continue with the last readable version.'
      : 'The stored lesson could not be displayed. You can generate it again.'}</p>
    <button disabled={disabled} onClick={() => tutor.prepare({ kind: 'teach' })}>Retry lesson generation</button>
    {tutor.provider !== 'demo' && <button disabled={disabled} onClick={() => tutor.prepare({ kind: 'teach' }, true)}>Preview lesson request</button>}
  </section>;
}

export function openingIntent(body: ReaderLesson): TutorIntent | null {
  if (body.mastery.needsAdaptation && body.mastery.revision) return { kind: 'adapt', revision: body.mastery.revision };
  if (body.invalidLatest) return null;
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
  signedIn: boolean | undefined;
  provider: TutorRequest['provider'];
  open: (id: number) => void;
}

export function LessonStart({ title, open, workspaceId, conceptId, depth, provider, signedIn }: StartProps) {
  const queue = useTutorJobs();
  const query = useCallback(async () => {
    const address = { workspaceId, conceptId, depth };
    const lesson = await call('reader:lesson', address);
    const intent = openingIntent(lesson);
    if (!intent) return { kind: 'saved' as const };
    if (signedIn === undefined) return { kind: 'checking' as const };
    if (!signedIn) return { kind: 'sign-in' as const };
    const request = { ...address, provider, intent };
    return { kind: 'preview' as const, request, data: await call('tutor:preview', request) };
  }, [workspaceId, conceptId, depth, provider, signedIn]);
  const { result, refresh } = useRead(query);
  const [, checkPermission] = useState(0);
  if (result.status === 'error') return <div role="alert">{result.message} <button onClick={refresh}>Retry next lesson</button></div>;
  const prepared = result.status === 'ready' && result.value.kind === 'preview' && result.value;
  const needsTutor = result.status === 'ready' && result.value.kind === 'sign-in';
  const running = queue.jobs.get(lessonKey({ workspaceId, conceptId, depth }));
  const active = running?.phase === 'running' || running?.phase === 'cancelling';
  const consent = prepared && !active && provider !== 'demo' && !hasTutorApproval(workspaceId, provider);
  function start() {
    if (result.status !== 'ready' || result.value.kind === 'checking') return;
    if (prepared && !active && provider !== 'demo' && !consent && !hasTutorApproval(workspaceId, provider)) {
      checkPermission(previous => previous + 1);
      return;
    }
    if (signedIn && prepared && !active) queue.start({ request: prepared.request, token: prepared.data.token, title });
    open(conceptId);
  }
  return <div className="next-start">
    {needsTutor && <p className="smallprint">Sign in to a tutor to generate this lesson. Tutor settings are in Lesson notes.</p>}
    {consent && <div className="next-preview"><PreviewMetadata provider={provider} data={prepared.data} />
      <ExactRequest data={prepared.data} /></div>}
    <button className="primary-btn" disabled={result.status === 'loading' || result.value.kind === 'checking'} onClick={start}>
      {consent ? 'Allow once & start ' : needsTutor ? 'Open ' : 'Start '}{title} <span aria-hidden="true">→</span></button>
  </div>;
}
