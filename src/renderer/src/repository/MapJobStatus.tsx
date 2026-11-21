import { useId } from 'react';
import { PROVIDER_LABELS } from '../preferences';
import { jobInProgress, useMapJobs, type RepositoryJob } from './MapJobs';
import { CopyGitHubLogin } from './ProviderReview';
import './repository.css';

interface Props {
  onOpen: (job: RepositoryJob) => void;
  onReview: (job: RepositoryJob) => void;
}

function stage(job: RepositoryJob) {
  const mapping = job.kind === 'map';
  switch (job.phase) {
    case 'generating': return mapping ? 'Generating map' : 'Generating change brief';
    case 'cancelling': return mapping ? 'Cancelling map' : 'Cancelling change brief';
    case 'cancelled': return mapping ? 'Map cancelled' : 'Change brief cancelled';
    case 'failed': return mapping ? 'Map generation failed' : 'Change brief generation failed';
    case 'ready': return mapping ? 'Map ready' : 'Change brief ready';
  }
}

function JobActions({ job, onOpen, onReview }: Props & { job: RepositoryJob }) {
  const queue = useMapJobs();
  const mapping = job.kind === 'map';
  if (job.phase === 'cancelling') return null;
  if (job.phase === 'generating') return <button onClick={() => void queue.cancel(job)}>
    {mapping ? 'Cancel map' : 'Cancel generation'}
  </button>;
  const mapRetry = job.kind === 'map' && (job.phase === 'cancelled' || (job.phase === 'failed' && job.failure.action === 'retry'));
  const providerIssue = job.phase === 'failed' && job.failure.action === 'provider';
  return <div className="actions">
    {job.phase === 'ready' && <button className="primary-btn" onClick={() => onOpen(job)}>{mapping ? 'Open map' : 'Open change brief'}</button>}
    {mapRetry && <button onClick={() => queue.retry(job)}>Retry map</button>}
    {job.phase === 'failed' && mapping && <button onClick={() => onReview(job)}>
      {providerIssue ? 'Review mapping provider' : 'Review map request'}
    </button>}
    {job.kind === 'change' && (job.phase === 'failed' || job.phase === 'cancelled') && <button onClick={() => onReview(job)}>
      {providerIssue ? 'Review brief provider' : 'Review and retry brief'}
    </button>}
    <button onClick={() => queue.dismiss(job)}>Dismiss</button>
  </div>;
}

function JobRow({ job, ...props }: Props & { job: RepositoryJob }) {
  const label = useId();
  const source = job.kind === 'change' ? ' · ' + job.title + ' · ' + job.depth + ' depth' : '';
  return <li className="map-job">
    <div className="map-job-detail">
      <div role="status" id={label}>
        <strong>{stage(job)} · {job.workspace.name}</strong>
        <span>{source} · {job.files.length} {job.files.length === 1 ? 'file' : 'files'} · {PROVIDER_LABELS[job.provider]}</span>
      </div>
      {jobInProgress(job) && <progress aria-labelledby={label} />}
      {job.phase === 'failed' && <div><p role="alert">{job.failure.message}</p><CopyGitHubLogin message={job.failure.message} /></div>}
      {job.phase === 'generating' && job.cancelError && <p role="alert">{job.cancelError}</p>}
    </div>
    <JobActions job={job} {...props} />
  </li>;
}

export function MapJobStatus(props: Props) {
  const { jobs } = useMapJobs();
  if (jobs.size === 0) return null;
  return <section className="map-jobs" aria-label="Repository generation">
    <ul>{Array.from(jobs.values(), job => <JobRow key={job.key} job={job} {...props} />)}</ul>
  </section>;
}
