import { Fragment, useId, useState } from 'react';
import { CHECK_ANSWER_LIMIT, type CodeSpan, type LessonBlock } from '../../../shared/lesson-blocks';
import { Environment } from '../lab/Environment';
import { Diagram } from './Diagram';
import './blocks.css';

export { Diagram };

function HighlightedLine({ line, spans }: { line: string; spans: CodeSpan[] }) {
  return <>{spans.map(({ start, end }, index) => <Fragment key={start}>
    {line.slice(spans[index - 1]?.end ?? 0, start)}<mark>{line.slice(start, end)}</mark>
  </Fragment>)}{line.slice(spans.at(-1)?.end ?? 0)}</>;
}

export function CodeExcerpt({ block }: { block: Extract<LessonBlock, { type: 'code' }> }) {
  const { lines, span, spans, source } = block;
  const highlights = new Map<number, CodeSpan[]>();
  for (const range of spans ?? (span ? [span] : [])) {
    const ranges = highlights.get(range.line);
    if (ranges) ranges.push(range);
    else highlights.set(range.line, [range]);
  }
  for (const ranges of highlights.values()) ranges.sort((a, b) => a.start - b.start);
  return <section className="chapter">
    <span className="plate">{highlights.size ? 'Highlighted source' : 'Source excerpt'} · {source}</span>
    <pre className="lesson-code"><code>{lines.map((line, index) => {
      const ranges = highlights.get(index + 1);
      return <Fragment key={index}>{index > 0 && '\n'}{ranges ? <HighlightedLine line={line} spans={ranges} /> : line}</Fragment>;
    })}</code></pre>
  </section>;
}

function Steps({ steps }: { steps: string[] }) {
  return <ol className="lesson-steps">{steps.map((step, i) => <li key={i}>{step}</li>)}</ol>;
}

function Comparison({ block }: { block: Extract<LessonBlock, { type: 'comparison' }> }) {
  const columns = 'columns' in block ? block.columns : ['Before', 'After'];
  const rows = 'rows' in block ? block.rows : [[block.before, block.after]];
  return <section className="chapter">
    <div className="lesson-table-wrap">
      <table className="lesson-table">
        <caption><h3>{block.heading}</h3></caption>
        <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>
          {row.map((cell, column) => <td key={column}>{cell}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function TeachingBlock({ block, blockIndex, messageId = null }: { block: Exclude<LessonBlock, { type: 'check' }>; blockIndex: number; messageId?: number | null }) {
  switch (block.type) {
    case 'prose':
      return <section className="chapter"><h3>{block.heading}</h3><p className="lesson-text">{block.text}</p></section>;
    case 'analogy':
    case 'callout':
      return <aside className="chapter"><div className="lesson-callout">
        {block.type === 'analogy' && <span className="eyebrow">Analogy</span>}
        <h3>{block.heading}</h3><p className="lesson-text">{block.text}</p>
      </div></aside>;
    case 'example':
      return <section className="chapter">
        <span className="eyebrow">Worked example</span>
        <h3>{block.heading}</h3><p className="lesson-text">{block.setup}</p>
        <Steps steps={block.steps} />
        <p className="lesson-text">{block.takeaway}</p>
      </section>;
    case 'comparison': return <Comparison block={block} />;
    case 'diagram': return <Diagram nodes={block.nodes} edges={block.edges} />;
    case 'code': return <CodeExcerpt block={block} />;
    case 'trace': return <section className="chapter"><h3>Trace</h3><Steps steps={block.steps} /></section>;
    case 'environment': return <Environment block={block} blockIndex={blockIndex} messageId={messageId} />;
    case 'unknown': return <section className="chapter"><h3>Unsupported lesson block</h3><p>This version of Delve cannot display “{block.name}”.</p></section>;
  }
}

interface CheckProps {
  block: Extract<LessonBlock, { type: 'check' }>;
  onAnswer: (answer: number | string) => void;
  onPreview?: (answer: number | string) => void;
  pending: boolean;
}

export function Check({ block, onAnswer, onPreview, pending }: CheckProps) {
  const prompt = useId();
  const [draft, setDraft] = useState('');
  const answer = draft.trim();
  return <section className="chapter" id="checkpoint"><div className="check" aria-busy={pending}>
    <span className="eyebrow">Check your understanding</span>
    <h3 id={prompt}>{block.prompt}</h3>
    <p>Answer to finish this lesson. You can skip, but this concept will not be marked understood.</p>
    {block.options
      ? <div className="actions">{block.options.map((option, index) =>
        <div className="check-choice" key={option}>
          <button type="button" onClick={() => onAnswer(index)} disabled={pending}>{option}</button>
          {onPreview && <button type="button" disabled={pending} aria-label={`Preview answer: ${option}`}
            onClick={() => onPreview(index)}>Preview</button>}
        </div>)}</div>
      : <form className="lesson-written-check" onSubmit={event => {
        event.preventDefault();
        if (!pending && answer) onAnswer(answer);
      }}>
        <textarea aria-labelledby={prompt} rows={3} required maxLength={CHECK_ANSWER_LIMIT}
          value={draft} onChange={event => setDraft(event.target.value)} disabled={pending} />
        <div className="actions">
          {onPreview && <button type="button" disabled={pending || !answer} onClick={() => onPreview(answer)}>Preview answer</button>}
          <button type="submit" disabled={pending || !answer}>Submit answer</button>
        </div>
      </form>}
  </div></section>;
}
