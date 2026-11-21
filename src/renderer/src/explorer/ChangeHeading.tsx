import type { ChangeDetail } from '../../../shared/explorer';
import type { ChangeRef } from '../../../shared/repository';
import { Icon } from '../Icon';

export const changeLabel = ({ kind, ref }: ChangeRef) => kind === 'pr' ? 'Pull request #' + ref : 'Commit ' + ref.slice(0, 9);

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function ChangeDate({ value, label }: { value: string; label?: string }) {
  return <time dateTime={value} title={value}>{label && label + ' '}{dateLabel(value)}</time>;
}

function Revision({ branch, sha }: { branch?: string; sha?: string }) {
  if (!branch && !sha) return null;
  return <code className="change-revision" title={[branch, sha].filter(Boolean).join(' · ')}>{branch || sha?.slice(0, 9)}</code>;
}

function ChangeMetadata({ detail }: { detail: ChangeDetail }) {
  const { node } = detail;
  const limit = detail.statsCoverage === 'lower-bound' ? 'At least ' : '';
  return <>
    <div className="change-byline">
      {node.author && <strong>{node.author}</strong>}
      {node.date && <ChangeDate value={node.date} label={node.kind === 'pr' ? 'Opened' : undefined} />}
      {detail.mergedAt ? <ChangeDate value={detail.mergedAt} label="Merged" /> : detail.closedAt && <ChangeDate value={detail.closedAt} label="Closed" />}
    </div>
    <div className="change-revisions">
      {node.kind === 'pr' ? <><Revision branch={node.baseBranch} sha={detail.base} /><span aria-label="from">←</span>
        <Revision branch={node.headBranch} sha={node.head} /></>
        : <>{node.branches.map(branch => <Revision key={branch} branch={branch} />)}<Revision sha={detail.base} />
          {detail.base && <span aria-label="to">→</span>}<Revision sha={node.head} /></>}
    </div>
    {detail.statsCoverage !== 'unavailable' && <div className="change-stats" aria-label="Change statistics">
      <span>{limit}{detail.fileCount.toLocaleString()} {detail.fileCount === 1 ? 'file' : 'files'} changed</span>
      <span className="lines-added" aria-label={limit + detail.additions + ' lines added'}>+{detail.additions.toLocaleString()}</span>
      <span className="lines-removed" aria-label={limit + detail.deletions + ' lines removed'}>−{detail.deletions.toLocaleString()}</span>
      {detail.partial && <span>{limit ? 'Counts are lower bounds' : 'Partial coverage'}</span>}
    </div>}
  </>;
}

export function ChangeHeading({ change, detail, savedTitle }: {
  change: ChangeRef; detail?: ChangeDetail; savedTitle?: string;
}) {
  return <header className="change-heading">
    <div className="change-heading-top"><span className="eyebrow">{changeLabel(change)}</span>
      {detail?.node.state && <span className={'pr-state ' + detail.node.state}><Icon name="pr" />{detail.node.state}</span>}
    </div>
    <h2>{detail?.node.title ?? savedTitle ?? changeLabel(change)}</h2>
    {detail && <ChangeMetadata detail={detail} />}
  </header>;
}
