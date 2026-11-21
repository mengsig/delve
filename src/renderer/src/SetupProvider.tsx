import { useEffect, useRef, useState } from 'react';
import type { ProviderId, ProviderState, ProviderStatus } from '../../shared/domain';
import { call } from './api';

const PROVIDERS = { codex: 'Codex', claude: 'Claude Code' } as const;
const STATES: Record<ProviderState, string> = {
  'signed-in': 'Signed in', 'signed-out': 'Signed out', 'api-key': 'API key detected',
  'not-found': 'CLI not found', unknown: 'Sign-in unknown',
};
const PREFERENCE_KEY = 'delve.provider';

function savedProvider(): ProviderId {
  return localStorage.getItem(PREFERENCE_KEY) === 'claude' ? 'claude' : 'codex';
}

export function SetupProvider() {
  const [provider, setProvider] = useState(savedProvider);
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [detectionError, setDetectionError] = useState('');
  const [preferenceError, setPreferenceError] = useState('');
  const request = useRef<Promise<ProviderStatus[]> | null>(null);

  useEffect(() => {
    let active = true;
    request.current ??= call('providers:detect', null);
    request.current.then(
      (detected) => { if (active) setStatuses(detected); },
      (failure: unknown) => { if (active) setDetectionError(failure instanceof Error ? failure.message : String(failure)); },
    );
    return () => { active = false; };
  }, []);

  function choose(id: ProviderId) {
    try {
      localStorage.setItem(PREFERENCE_KEY, id);
      setProvider(id);
      setPreferenceError('');
    } catch (failure) {
      setPreferenceError(`Could not save your CLI preference. ${failure instanceof Error ? failure.message : String(failure)}`);
    }
  }

  const selected = statuses.find((status) => status.id === provider);
  return (
    <fieldset className="formrow">
      <legend>03 &nbsp; Your signed-in CLI</legend>
      <div className="seg setup-segment">
        {(['codex', 'claude'] as const).map((id) => {
          const status = statuses.find((item) => item.id === id);
          return (
            <button key={id} type="button" aria-pressed={provider === id} onClick={() => choose(id)}
              data-provider={id} data-state={status?.state}>
              {PROVIDERS[id]}{status && <span className="provider-state">{STATES[status.state]}</span>}
            </button>
          );
        })}
      </div>
      {preferenceError && <p role="alert" className="setup-error">{preferenceError}</p>}
      {detectionError && <p role="alert" className="setup-error">{detectionError}</p>}
      <p role="status" className="smallprint">{selected ? providerHint(selected) : detectionError ? '' : 'Checking installed CLIs…'}</p>
    </fieldset>
  );
}

function providerHint(status: ProviderStatus): string {
  switch (status.state) {
    case 'signed-in': return `${PROVIDERS[status.id]} is ready to use with your subscription.`;
    case 'signed-out': return `Sign in to ${PROVIDERS[status.id]} with your subscription to use the tutor.`;
    case 'not-found': return `You can add this workspace now. Install and sign in to ${PROVIDERS[status.id]} to use the tutor.`;
    case 'api-key': return `Switch ${PROVIDERS[status.id]} to a subscription login to use the tutor.`;
    case 'unknown': return `Check your ${PROVIDERS[status.id]} login. ${status.detail}`;
  }
}
