export function ReadState({ label, message, retry }: { label: string; message?: string; retry?: () => void }) {
  return (
    <section className="sheet read-state" aria-label={label}>
      <span className="eyebrow">Delve / {label}</span>
      {message !== undefined ? <>
        <h2>Couldn’t load {label.toLowerCase()}.</h2>
        <p role="alert">{message}</p>
        <button onClick={retry}>Try again</button>
      </> : <p role="status">Loading {label.toLowerCase()}…</p>}
    </section>
  );
}
