import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from './Icon';

const preference = window.matchMedia('(prefers-color-scheme: dark)');
const systemTheme = () => preference.matches ? 'dark' : 'light';

function listenToSystem(onChange: () => void) {
  preference.addEventListener('change', onChange);
  return () => preference.removeEventListener('change', onChange);
}

function savedTheme() {
  const value = localStorage.getItem('delve.theme');
  return value === 'dark' || value === 'light' ? value : null;
}

document.documentElement.dataset.theme = savedTheme() ?? systemTheme();

export function ThemeButton() {
  const system = useSyncExternalStore(listenToSystem, systemTheme);
  const [manual, setManual] = useState(savedTheme);
  const theme = manual ?? system;
  const next = theme === 'dark' ? 'light' : 'dark';
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  function toggle() {
    if (next === system) localStorage.removeItem('delve.theme');
    else localStorage.setItem('delve.theme', next);
    setManual(next === system ? null : next);
  }
  return <button className="tool" aria-label={`Use ${next} theme`} title={`Use ${next} theme`} onClick={toggle}>
    <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
  </button>;
}
