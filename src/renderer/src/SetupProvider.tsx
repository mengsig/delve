import { useEffect, useRef, useState } from 'react';
import type { ProviderId, ProviderState, ProviderStatus } from '../../shared/domain';
import { call } from './api';
import { PROVIDER_LABELS, storeProvider } from './preferences';
import { errorMessage } from './useRead';

const STATES: Record<ProviderState, string> = {
  'signed-in': 'Signed in', 'signed-out': 'Signed out', 'api-key': 'API key detected',
  'not-found': 'CLI not found', unknown: 'Sign-in unknown',
};
interface Props {
  provider: ProviderId;
  onChange: (provider: ProviderId) => void;
  label?: string;
  disabled?: boolean;
}

export function SetupProvider({ provider, onChange, label = '03  Your signed-in CLI', disabled }: Props) {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [detectionError, setDetectionError] = useState('');
  const [preferenceError, setPreferenceError] = useState('');
  const request = useRef<Promise<ProviderStatus[]> | null>(null);

  useEffect(() => {
    let active = true;
    request.current ??= call('providers:detect', null);
    request.current.then(
      (detected) => { if (active) setStatuses(detected); },
      (failure: unknown) => { if (active) setDetectionError(errorMessage(failure)); },
    );
    return () => { active = false; };
  }, []);

  function choose(id: ProviderId) {
    try {
      storeProvider(id);
      onChange(id);
      setPreferenceError('');
    } catch (failure) {
      setPreferenceError(`Could not save your CLI preference. ${errorMessage(failure)}`);
    }
  }

  const selected = statuses.find((status) => status.id === provider);
  return (
    <fieldset className="formrow" disabled={disabled}>
      <legend>{label}</legend>
      <div className="seg setup-segment">
        {(['codex', 'claude'] as const).map((id) => {
          const status = statuses.find((item) => item.id === id);
          return (
            <button key={id} type="button" aria-pressed={provider === id} onClick={() => choose(id)}
              data-provider={id} data-state={status?.state}>
              {PROVIDER_LABELS[id]}{status && <span className="provider-state">{STATES[status.state]}</span>}
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
    case 'signed-in': return `${PROVIDER_LABELS[status.id]} is ready to use with your subscription.`;
    case 'signed-out': return `Sign in to ${PROVIDER_LABELS[status.id]} with your subscription to use the tutor.`;
    case 'not-found': return `Install and sign in to ${PROVIDER_LABELS[status.id]} to use the tutor.`;
    case 'api-key': return `Switch ${PROVIDER_LABELS[status.id]} to a subscription login to use the tutor.`;
    case 'unknown': return `Check your ${PROVIDER_LABELS[status.id]} login. ${status.detail}`;
  }
}
