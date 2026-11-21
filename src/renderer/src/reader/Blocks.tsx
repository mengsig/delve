import { Fragment, useState } from 'react';
import type { LessonAddress, LessonBlock } from '../../../shared/reader';
import { call } from '../api';

export function CodeExcerpt({ block }: { block: Extract<LessonBlock, { type: 'code' }> }) {
  const { lines, span, source } = block;
  return <section className="chapter">
    <span className="plate">Highlighted source · {source}</span>
    <pre><code>{lines.map((line, index) => <Fragment key={index}>
      {index > 0 && '\n'}{span?.line === index + 1
        ? <>{line.slice(0, span.start)}<mark>{line.slice(span.start, span.end)}</mark>{line.slice(span.end)}</>
        : line}
    </Fragment>)}</code></pre>
  </section>;
}

export function Diagram({ nodes }: { nodes: string[] }) {
  return <section className="chapter">
    <span className="plate">System trace</span>
    <div className="diagram">{nodes.map((node, index) => <Fragment key={index}>
      {index > 0 && <b aria-hidden="true">→</b>}<span>{node}</span>
    </Fragment>)}</div>
  </section>;
}

export function EnvironmentSlot({ fallback }: { fallback?: string }) {
  return <section className="chapter" id="instrument">
    <span className="eyebrow">Environment</span>
    <h3>No environment in this lesson</h3>
    {fallback && <p>{fallback}</p>}
  </section>;
}

export function TeachingBlock({ block }: { block: Exclude<LessonBlock, { type: 'check' }> }) {
  switch (block.type) {
    case 'prose': return <section className="chapter"><h3>{block.heading}</h3><p>{block.text}</p></section>;
    case 'diagram': return <Diagram nodes={block.nodes} />;
    case 'code': return <CodeExcerpt block={block} />;
    case 'trace': return <section className="chapter"><h3>Trace</h3><ol>{block.steps.map((step, i) => <li key={i}>{step}</li>)}</ol></section>;
    case 'environment': return <EnvironmentSlot fallback={block.fallback} />;
    case 'unknown': return <section className="chapter"><h3>Unsupported lesson block</h3><p>This version of Delve cannot display “{block.name}”.</p></section>;
  }
}

interface CheckProps {
  block: Extract<LessonBlock, { type: 'check' }>;
  address: LessonAddress;
  revision: string;
  onEvidence?: () => void;
}

export function Check({ block, address, revision, onEvidence }: CheckProps) {
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  async function answer(option: number) {
    setPending(true);
    try {
      const result = await call('reader:answer', { ...address, revision, option });
      setFeedback(result.feedback);
      if (result.demonstrated) onEvidence?.();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  }
  return <section className="chapter" id="checkpoint"><div className="check">
    <span className="eyebrow">One check · optional</span>
    <h3>{block.prompt}</h3>
    <p>A successful prediction saves evidence at this depth in your local atlas.</p>
    <div className="actions">{block.options.map((option, i) =>
      <button key={option} onClick={() => void answer(i)} disabled={pending}>{option}</button>)}</div>
    <div className="feedback" role="status">{feedback}</div>
  </div></section>;
}
