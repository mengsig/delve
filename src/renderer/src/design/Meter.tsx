import './meter.css';

interface Props {
  label: string;
  value: number;
  max: number;
  detail?: string;
  tone?: 'mastered' | 'in-progress' | 'ready' | 'locked';
  hatched?: boolean;
}

export function Meter({ label, value, max, detail, tone, hatched }: Props) {
  if (!Number.isFinite(max) || max < 0) throw new Error('A meter needs a non-negative maximum.');
  if (!Number.isFinite(value) || value < 0 || value > max) throw new Error('A meter value must fit its scale.');
  return <div className="learning-meter" data-tone={tone} data-hatched={hatched || undefined}>
    <div className="learning-meter-label"><span>{label}</span><span>{detail ?? `${value} / ${max}`}</span></div>
    {hatched || max === 0 ? <div className="learning-meter-track" aria-hidden="true" />
      : <meter className="learning-meter-track" aria-label={label} aria-valuetext={detail ?? `${value} of ${max}`}
        min={0} max={max} value={value} />}
  </div>;
}
