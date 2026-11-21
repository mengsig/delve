import type { KeyboardEvent } from 'react';

const tabs = ['Explanation', 'Files changed', 'Concepts'] as const;
export type ChangeTab = typeof tabs[number];
export const tabId = (name: ChangeTab) => 'change-tab-' + tabs.indexOf(name);

export function ChangeTabs({ selected, onSelect }: { selected: ChangeTab; onSelect: (tab: ChangeTab) => void }) {
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    const tab = tabs[next];
    if (!tab) return;
    event.preventDefault();
    onSelect(tab);
    document.getElementById(tabId(tab))?.focus();
  }
  return <div className="change-tabs" role="tablist" aria-label="Change details">
    {tabs.map((tab, index) => <button key={tab} id={tabId(tab)} role="tab" aria-selected={selected === tab}
      aria-controls="change-panel" tabIndex={selected === tab ? 0 : -1}
      onClick={() => onSelect(tab)} onKeyDown={event => navigate(event, index)}>{tab}</button>)}
  </div>;
}
