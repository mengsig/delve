import { useState } from 'react';
import type { RepositoryFile } from '../../../shared/repository';
import { fitsFileSlice, MAX_BYTES, MAX_FILE_BYTES, MAX_FILES } from './fileSelection';

export function RepositoryFiles({ files, paths, onChange }: {
  files: RepositoryFile[]; paths: Set<string>; onChange: (paths: Set<string>) => void;
}) {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const shown = files.filter(file => file.path.toLowerCase().includes(query));
  const bytes = files.reduce((total, file) => paths.has(file.path) ? total + file.bytes : total, 0);

  function toggle(file: RepositoryFile) {
    const next = new Set(paths);
    if (!next.delete(file.path)) {
      if (!fitsFileSlice(file, paths.size, bytes)) return;
      next.add(file.path);
    }
    onChange(next);
  }

  return <details className="attach-files">
    <summary>Edit files ({paths.size} selected)</summary>
    <div className="formrow">
      <label htmlFor="attach-file-filter">Filter repository files</label>
      <input id="attach-file-filter" value={filter} onChange={event => setFilter(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    </div>
    <p className="smallprint" role="status">
      {paths.size} of {MAX_FILES} files · {bytes.toLocaleString()} of {MAX_BYTES.toLocaleString()} bytes.
      Each file can be up to {MAX_FILE_BYTES.toLocaleString()} bytes.
    </p>
    {shown.length ? <ul className="repository-files" aria-label="Repository files">
      {shown.map(file => <li key={file.path}><label>
        <input type="checkbox" aria-label={file.path} checked={paths.has(file.path)}
          disabled={!paths.has(file.path) && !fitsFileSlice(file, paths.size, bytes)} onChange={() => toggle(file)} />
        <code>{file.path}</code><small>{file.bytes.toLocaleString()} bytes</small>
      </label></li>)}
    </ul> : <div><p role="status">No files match this filter.</p>
      <button type="button" onClick={() => setFilter('')}>Clear filter</button></div>}
  </details>;
}
