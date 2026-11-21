import type { ComponentProps } from 'react';
import type { Workspace } from '../../../shared/domain';
import { Icon } from '../Icon';
import type { DemoPlate } from './demoAtlas';
import { isLearned, type AtlasConcept, type AtlasModel } from './model';

interface CardProps {
  label: string;
  title: string;
  reason: string;
  icon: ComponentProps<typeof Icon>['name'];
  primary?: boolean;
  onClick: () => void;
}

function Suggestion({ label, title, reason, icon, primary, onClick }: CardProps) {
  return <button className={'rec' + (primary ? ' primary' : '')} onClick={onClick}>
    <span className="ico-box"><Icon name={icon} /></span>
    <span><span className="eyebrow">{label}</span><strong>{title}</strong><small>{reason}</small></span>
    <span className="arr" aria-hidden="true">↗</span>
  </button>;
}

function reasonFor(target: AtlasConcept, workspaceId: string): string {
  if (isLearned(target)) return 'This depth is covered. Revisit only if you want to.';
  const evidence = target.evidence;
  if (evidence) {
    const why = evidence.status === 'partial' ? 'Your evidence shows partial understanding at this depth.' : 'You marked this concept for another look.';
    return evidence.note ? why + ' ' + evidence.note : why;
  }
  const prior = target.prerequisites[0];
  if (prior) {
    const from = prior.evidence?.workspaceName;
    if (from && prior.evidence?.workspaceId !== workspaceId) return 'Build on ' + prior.title.toLowerCase() + ', already known from ' + from + '.';
    return 'Build on ' + target.prerequisites.map(concept => concept.title.toLowerCase()).join(' and ') + ', already learned at this depth.';
  }
  const next = target.dependents[0];
  return next ? 'A foundation for ' + next.title.toLowerCase() + '.' : 'Start here. This concept has no prerequisites.';
}

interface Props {
  workspace: Workspace;
  model: AtlasModel;
  target: AtlasConcept;
  reason?: string;
  demo?: DemoPlate;
  onLesson: (id: number) => void;
  onChanges: () => void;
}

export function FieldGuide({ workspace, model, target, reason, demo, onLesson, onChanges }: Props) {
  const missing = Array.from(model.byId.values()).filter(concept => !isLearned(concept) && concept.id !== target.id);
  const feature = demo?.feature && missing.includes(demo.feature) ? demo.feature : missing.find(concept => concept.prerequisites.length);
  const follow = demo && !demo.changed && missing.find(concept => concept !== feature && concept.prerequisites.includes(target));
  const revisit = isLearned(target);
  const label = revisit ? 'Optional revisit' : reason || target.evidence ? 'Adaptive follow-up' : 'Learn the base';
  return <aside className="recs" aria-label="Field guide">
    <header><span className="eyebrow">Field guide / Suggested for you</span><h3>Your next move</h3></header>
    <Suggestion primary icon="route" label={label} title={target.title}
      reason={reason ?? reasonFor(target, workspace.id)} onClick={() => onLesson(target.id)} />
    {demo?.changed ? <Suggestion icon="pr" label="Change brief · PR #184" title="Why late writes are rejected"
      reason="One changed boundary. Skip the queue recap." onClick={onChanges} />
      : workspace.kind !== 'topic' && !demo && <Suggestion icon="pr" label="Change brief" title="Explore repository changes"
        reason="See which concepts a commit or pull request touches." onClick={onChanges} />}
    {follow && <Suggestion icon={workspace.kind === 'topic' ? 'frame' : 'book'} label="Follow a connection"
      title={follow.title} reason={follow.title + ' builds on ' + target.title.toLowerCase() + '.'} onClick={() => onLesson(follow.id)} />}
    {feature && <Suggestion icon="layer" label={workspace.kind === 'topic' ? 'Explore an application' : 'Explain a feature'}
      title={feature.title} reason={feature.summary || 'Connect ' + feature.title + ' to its prerequisites.'}
      onClick={() => onLesson(feature.id)} />}
  </aside>;
}
