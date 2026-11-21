import { useId } from 'react';
import type { Depth } from '../../../shared/domain';
import type { RepoPreview } from '../../../shared/repository';
import { Icon } from '../Icon';
import { PROVIDER_LABELS } from '../preferences';
import { CopyGitHubLogin, RepositoryRequestSource } from '../repository/ProviderReview';
import { AlwaysAllowSource, RevokeSourceApproval } from '../repository/SourceApproval';
import type { LessonState } from './useChangeLesson';

function TeachButton({ onClick, describedBy, refresh }: { onClick: () => void; describedBy?: string; refresh?: boolean }) {
  return <button className="primary-btn teach-change" onClick={onClick} aria-describedby={describedBy}>
    <Icon name="book" />{refresh ? 'Approve and explain' : 'Teach me this change'}
  </button>;
}

function ChangeSourceReview({ lesson, depth, preview }: { lesson: LessonState; depth: Depth; preview: RepoPreview }) {
  const title = useId();
  const disclosure = useId();
  const { approval, provider, job, reviewRefresh, draftToken, setDraftToken, start } = lesson;
  const needsRetry = job?.phase === 'failed' && job.failure.action === 'review' && job.token === preview.token;
  if (needsRetry) return <button className="primary-btn" onClick={lesson.review.retry}>Prepare the diff again</button>;

  function send() {
    if (start(preview, !reviewRefresh)) lesson.setReviewRefresh(false);
  }

  if (approval.allowed && !reviewRefresh) return <div className="actions">
    <TeachButton onClick={send} />
    <details className="approved-change-source"><summary>Preview diff request</summary>
      <section className="repository-review" aria-labelledby={title}>
        <h3 id={title}>Review provider request</h3>
        <RepositoryRequestSource preview={preview} provider={provider} depth={depth} inlinePrompt />
      </section>
    </details>
  </div>;

  return <section className="repository-review" aria-labelledby={title}>
    <h3 id={title}>Review provider request</h3>
    <RepositoryRequestSource preview={preview} provider={provider} depth={depth} inlinePrompt={reviewRefresh} />
    <p id={disclosure}>
      {reviewRefresh ? 'Approve and explain' : 'Teach me this change'} sends the source shown above to {PROVIDER_LABELS[provider]}.
    </p>
    {!approval.allowed && <AlwaysAllowSource provider={provider} category="change" checked={draftToken === preview.token}
      onChange={checked => setDraftToken(checked ? preview.token : undefined)} />}
    <div className="actions">
      <TeachButton onClick={send} describedBy={disclosure} refresh={reviewRefresh} />
      {reviewRefresh && <button onClick={() => lesson.setReviewRefresh(false)}>Dismiss preview</button>}
    </div>
  </section>;
}

export function ChangeLessonAction({ lesson, depth, onLesson, onRefreshDetails, checkingDetails }: {
  lesson: LessonState; depth: Depth; onLesson: (id: number) => void; onRefreshDetails: () => void; checkingDetails: boolean;
}) {
  const { brief, running, review, saved, approval, provider, canPrepare } = lesson;
  const preview = review.result.status === 'ready' ? review.result.value : undefined;
  const previewError = review.result.status === 'error' ? review.result.message : undefined;
  return <div className="change-lesson-action">
    {brief && !checkingDetails && <div className="actions">
      <TeachButton onClick={() => onLesson(brief.conceptId)} />
      {lesson.sourceAvailable && !running && !lesson.reviewRefresh &&
        <button onClick={() => lesson.setReviewRefresh(true)}>Preview diff request</button>}
    </div>}
    {approval.allowed && <RevokeSourceApproval provider={provider} category="change" onRevoke={() => approval.setAllowed(false)} />}
    {running ? <p role="status">Generating the change lesson…</p> : canPrepare && <>
      {review.result.status === 'loading' && <p role="status">Preparing the change diff for review…</p>}
      {preview && <ChangeSourceReview lesson={lesson} depth={depth} preview={preview} />}
      {previewError && <div className="repository-notice"><p role="alert">{previewError}</p>
        <div className="actions">
          <CopyGitHubLogin message={previewError} />
          <button onClick={review.retry}>Retry diff preview</button>
          <button onClick={onRefreshDetails}>Refresh change details</button>
        </div>
      </div>}
    </>}
    {saved.result.status === 'loading' && <p role="status">Looking for a saved brief…</p>}
    {saved.result.status === 'error' && <div className="repository-notice"><p role="alert">{saved.result.message}</p>
      <button onClick={saved.refresh}>Retry saved brief</button></div>}
    {lesson.error && <p role="alert" className="setup-error">{lesson.error}</p>}
  </div>;
}
