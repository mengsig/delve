import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../../../shared/domain';
import type { LearnIntent } from '../../../shared/repository';
import { call } from '../api';
import { errorMessage } from '../useRead';
import './repository.css';

const LINK_KIND = { proposed: 'Proposed change', commit: 'Commit', pr: 'Pull request' };

function usePendingLearnLink(onAccepted: (intent: LearnIntent, workspace: Workspace) => void) {
  const [intent, setIntent] = useState<LearnIntent>();
  const [error, setError] = useState('');
  const [resolution, setResolution] = useState<{ id: string; error: string }>();
  const [processing, setProcessing] = useState(false);
  const [notice, setNotice] = useState('');
  const resolving = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    async function poll() {
      const version = revision.current;
      try {
        if (resolving.current) return;
        const next = await call('learn:pending', null);
        if (!active || revision.current !== version) return;
        setIntent(previous => previous?.id === next?.id ? previous : next ?? undefined);
        setError('');
      } catch (cause) {
        if (active && revision.current === version) setError(errorMessage(cause));
      } finally {
        if (active) timer = window.setTimeout(() => void poll(), 1200);
      }
    }
    void poll();
    return () => { active = false; window.clearTimeout(timer); };
  }, []);

  async function resolve(accept: boolean) {
    if (!intent || resolving.current) return;
    resolving.current = true;
    revision.current++;
    setProcessing(true);
    setResolution(undefined);
    setNotice('');
    try {
      const workspace = await call('learn:resolve', { id: intent.id, accept });
      if (accept && !workspace) throw new Error('The link did not open a workspace.');
      setIntent(undefined);
      if (workspace && accept) onAccepted(intent, workspace);
      else setNotice('Learn link rejected.');
    } catch (cause) {
      setResolution({ id: intent.id, error: errorMessage(cause) });
    } finally {
      resolving.current = false;
      setProcessing(false);
    }
  }
  const failure = resolution?.id === intent?.id ? resolution?.error : undefined;
  return { intent, error, failure, processing, notice, resolve };
}

export function LearnLink({ onAccepted }: { onAccepted: (intent: LearnIntent, workspace: Workspace) => void }) {
  const { intent, error, failure, processing, notice, resolve } = usePendingLearnLink(onAccepted);
  if (!intent) return <>
    {error && <p role="alert">Couldn’t check for learn links. {error}</p>}
    {notice && <p role="status">{notice}</p>}
  </>;
  return <section className="card learn-intent" aria-labelledby="learn-intent-title">
    <h2 id="learn-intent-title">Incoming learn link</h2>
    <p>This request came from a link opened outside Delve. Review the source before accepting.</p>
    <dl>
      <dt>Workspace</dt><dd><code>{intent.workspace}</code></dd>
      <dt>{LINK_KIND[intent.kind]}</dt><dd><code>{intent.ref}</code></dd>
    </dl>
    <div className="actions">
      <button className="primary-btn" disabled={processing} onClick={() => void resolve(true)}>Accept and open</button>
      <button disabled={processing} onClick={() => void resolve(false)}>Reject link</button>
    </div>
    {processing && <p role="status">Resolving learn link…</p>}
    {(failure || error) && <p role="alert">{failure || error}</p>}
  </section>;
}
