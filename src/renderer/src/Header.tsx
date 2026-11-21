import { Icon } from './Icon';
import { ThemeButton } from './ThemeButton';

export type Screen = 'atlas' | 'changes' | 'progress' | 'lesson' | 'setup';

const links = [
  { screen: 'atlas', icon: 'atlas', label: 'Atlas' },
  { screen: 'changes', icon: 'pr', label: 'Changes' },
  { screen: 'progress', icon: 'profile', label: 'Progress' },
] as const;

export function Header({ screen, go, openSwitcher }: { screen: Screen; go: (screen: Screen) => void; openSwitcher: () => void }) {
  return <header className="windowbar">
    <button className="brand" onClick={openSwitcher} aria-label="Switch workspace" title="Switch workspace (Ctrl or ⌘ K)">
      <svg className="mark" viewBox="0 0 36 36" aria-hidden="true">
        <path d="M2 14 18 4l16 10-16 10z" fill="currentColor" />
        <path d="m3 19 15 9 15-9M3 24l15 9 15-9" stroke="currentColor" fill="none" strokeWidth="2.8" strokeLinejoin="round" />
        <path d="m18 9 6 4-6 4-6-4z" fill="var(--surface)" />
      </svg>
      Delve
    </button>
    <nav className="appnav" aria-label="Application">
      {links.map(link => <button key={link.screen} aria-current={screen === link.screen ? 'page' : undefined} onClick={() => go(link.screen)}>
        <Icon name={link.icon} />{link.label}
      </button>)}
    </nav>
    <div className="row">
      <button className="tool" onClick={() => go('setup')} title="Add a workspace">+ Add</button>
      <ThemeButton />
    </div>
  </header>;
}
