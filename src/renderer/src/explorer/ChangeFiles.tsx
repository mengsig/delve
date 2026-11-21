import { useMemo, useState } from 'react';
import type { ChangeDetail } from '../../../shared/explorer';
import { patchLines, type DiffLine } from '../../../shared/change-diff';
import type { ChangeBrief } from '../../../shared/repository';

type FileEntry = ChangeDetail['files'][number];
type LinkedConcept = ChangeBrief['touched'][number];
const PAGE_SIZE = 120;

interface Directory {
  folders: Map<string, Directory>;
  files: FileEntry[];
}

function directoryTree(files: FileEntry[]) {
  const root: Directory = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      const child = folder.folders.get(part) ?? { folders: new Map<string, Directory>(), files: [] };
      folder.folders.set(part, child);
      folder = child;
    }
    folder.files.push(file);
  }
  return root;
}

interface Selection { selected: string; onSelect: (file: string) => void }

function Folder({ folder, selected, onSelect }: Selection & { folder: Directory }) {
  return <ul>{Array.from(folder.folders, ([name, child]) => <li key={'dir/' + name}>
    <details open><summary>{name}/</summary><Folder folder={child} selected={selected} onSelect={onSelect} /></details>
  </li>)}{folder.files.map(file => <li key={file.path}><button aria-current={file.path === selected ? 'true' : undefined}
    title={file.path} onClick={() => onSelect(file.path)}>{file.path.slice(file.path.lastIndexOf('/') + 1)}</button></li>)}</ul>;
}

function FileTree({ files, ...selection }: Selection & { files: FileEntry[] }) {
  const root = useMemo(() => directoryTree(files), [files]);
  return <nav className="diff-tree" aria-label="Changed files"><Folder folder={root} {...selection} /></nav>;
}

function lineConcepts(path: string, brief?: ChangeBrief) {
  const links = new Map<string, LinkedConcept[]>();
  const concepts = new Map(brief?.touched.map(concept => [concept.id, concept]));
  for (const span of brief?.spans ?? []) {
    const concept = concepts.get(span.conceptId);
    if (span.path !== path || !concept) continue;
    const key = span.side + '/' + span.start;
    const group = links.get(key) ?? [];
    const title = span.start === span.end ? concept.title : concept.title + ' · lines ' + span.start + '–' + span.end;
    group.push({ ...concept, title });
    links.set(key, group);
  }
  return links;
}

function PatchRow({ row, links, onConcept }: { row: DiffLine; links: Map<string, LinkedConcept[]>; onConcept: (id: number) => void }) {
  const annotations = row.kind === 'addition' ? links.get('new/' + row.newLine)
    : row.kind === 'deletion' ? links.get('old/' + row.oldLine) : undefined;
  return <div className={'patch-line ' + row.kind} role="row">
    <span className="line-number" role="cell">{row.oldLine}</span>
    <span className="line-number" role="cell">{row.newLine}</span>
    <div role="cell"><code>{row.text}</code>{annotations && <div className="line-concepts">
      {annotations.map((concept, index) => <button key={index} onClick={() => onConcept(concept.id)}>{concept.title} ↗</button>)}
    </div>}</div>
  </div>;
}

function Patch({ file, brief, onConcept }: { file: FileEntry; brief?: ChangeBrief; onConcept: (id: number) => void }) {
  const [offset, setOffset] = useState(0);
  const rows = useMemo(() => file.patch ? patchLines(file.patch) : [], [file.patch]);
  const links = useMemo(() => lineConcepts(file.path, brief), [file.path, brief]);
  return <section className="file-patch" aria-label={'Diff for ' + file.path}>
    <h3 className="mono">{file.path}</h3>
    {rows.length ? <div className="patch-scroll" role="table" aria-label="Unified diff" tabIndex={0}>
      <div className="patch-line patch-labels" role="row"><span role="columnheader">Old</span>
        <span role="columnheader">New</span><span role="columnheader">Patch</span></div>
      {rows.slice(offset, offset + PAGE_SIZE).map((row, index) =>
        <PatchRow key={offset + index} row={row} links={links} onConcept={onConcept} />)}
    </div> : <p className="panel-message">No text patch is available for this file.</p>}
    {rows.length > PAGE_SIZE && <div className="patch-pages">
      <button disabled={!offset} onClick={() => setOffset(offset - PAGE_SIZE)}>Previous lines</button>
      <span role="status">{offset + 1}–{Math.min(offset + PAGE_SIZE, rows.length)} of {rows.length}</span>
      <button disabled={offset + PAGE_SIZE >= rows.length} onClick={() => setOffset(offset + PAGE_SIZE)}>Next lines</button>
    </div>}
  </section>;
}

export function ChangeFiles({ detail, brief, onConcept }: { detail: ChangeDetail; brief?: ChangeBrief; onConcept: (id: number) => void }) {
  const [path, setPath] = useState('');
  const file = detail.files.find(entry => entry.path === path) ?? detail.files[0];
  return <div>
    {detail.partial && <p className="repository-notice" role="status"><strong>Partial coverage.</strong>{' '}
      {detail.coverageNote ?? 'Some files or lines are outside the available text diff.'}</p>}
    {file ? <div className={detail.files.length > 1 ? 'files-layout' : undefined}>
      {detail.files.length > 1 && <FileTree files={detail.files} selected={file.path} onSelect={setPath} />}
      <Patch key={file.path} file={file} brief={brief} onConcept={onConcept} /></div>
      : <p className="panel-message">{detail.partial ? 'No file patches are available.' : 'This change has no file edits.'}</p>}
  </div>;
}
