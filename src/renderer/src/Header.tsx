import { Icon } from './Icon';
import { ThemeButton } from './ThemeButton';

import { primaryViews } from './commands';
import type { Screen } from './navigation';
import { useRef } from 'react';

declare const __DELVE_VERSION__: string;

type HeaderScreen = typeof primaryViews[number]['screen'] | 'setup';

export function Header({ screen, go, openSwitcher }: { screen: Screen; go: (screen: HeaderScreen) => void; openSwitcher: () => void }) {
  const about = useRef<HTMLDialogElement>(null);
  return <header className="windowbar">
    <button className="brand" onClick={openSwitcher} aria-label="Switch workspace" title="Switch workspace (Ctrl or ⌘ K)">
      <svg className="mark" viewBox="0 0 36 36" aria-hidden="true">
        <path d="M2 14 18 4l16 10-16 10z" fill="currentColor" />
        <path d="m3 19 15 9 15-9M3 24l15 9 15-9" stroke="currentColor" fill="none" strokeWidth="2.8" strokeLinejoin="round" />
        <path d="m18 9 6 4-6 4-6-4z" fill="var(--surface)" />
      </svg>
      Delve <kbd aria-hidden="true">{/Mac/i.test(navigator.platform) ? '⌘ K' : 'Ctrl K'}</kbd>
    </button>
    <nav className="appnav" aria-label="Application">
      {primaryViews.map(link => <button key={link.screen} aria-current={screen === link.screen ? 'page' : undefined} onClick={() => go(link.screen)}>
        <Icon name={link.icon} />{link.label}
      </button>)}
    </nav>
    <div className="row">
      <button className="tool" onClick={() => go('setup')} title="Add a workspace">+ Add</button>
      <ThemeButton />
      <button className="tool" onClick={() => about.current?.showModal()}>About</button>
      <dialog ref={about} className="workspace-palette" aria-labelledby="about-title">
        <div className="palette-header"><h2 id="about-title">About Delve</h2></div>
        <p>Delve {__DELVE_VERSION__}</p>
        <p>Learn the codebase your agents are building.</p>
        <form method="dialog"><button autoFocus>Close</button></form>
      </dialog>
    </div>
  </header>;
}
