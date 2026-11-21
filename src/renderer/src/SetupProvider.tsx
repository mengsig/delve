import { useEffect, useRef, useState } from 'react';
import type { ProviderId, ProviderState, ProviderStatus } from '../../shared/domain';
import { call } from './api';
import { PROVIDER_LABELS, storeProvider } from './preferences';
import { errorMessage } from './useRead';

const STATES: Record<ProviderState, string> = {
  'signed-in': 'Signed in', 'signed-out': 'Signed out', 'api-key': 'API key detected',
  'not-found': 'CLI not found', unknown: 'Sign-in unknown',
};
export function useProviderDetection(enabled = true) {
  const [version, setVersion] = useState(0);
  const [settled, setSettled] = useState<{ version: number; statuses: ProviderStatus[]; error?: string }>();
  const request = useRef<{ version: number; pending: Promise<ProviderStatus[]> } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    if (request.current?.version !== version) request.current = { version, pending: call('providers:detect', null) };
    void request.current.pending.then(
      statuses => { if (current) setSettled({ version, statuses }); },
      failure => { if (current) setSettled({ version, statuses: [], error: errorMessage(failure) }); },
    );
    return () => { current = false; };
  }, [enabled, version]);

  const result = settled?.version === version ? settled : undefined;
  return {
    statuses: result?.statuses ?? [],
    error: result?.error,
    checking: !result,
    retry: () => setVersion(value => value + 1),
  };
}

interface Props {
  provider: ProviderId;
  onChange: (provider: ProviderId) => void;
  label?: string;
  disabled?: boolean;
  detection?: ReturnType<typeof useProviderDetection>;
}

export function SetupProvider({ provider, onChange, label = '03 \u00a0 Your signed-in CLI', disabled, detection }: Props) {
  const ownDetection = useProviderDetection(!detection);
  const { statuses, error, checking, retry } = detection ?? ownDetection;
  const [preferenceError, setPreferenceError] = useState('');

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
      {error && <p role="alert" className="setup-error">Could not check the installed CLIs. {error}</p>}
      <p role="status" className="smallprint">
        {selected ? providerHint(selected) : checking ? 'Checking installed CLIs…' : ''}
      </p>
      {detection && !checking &&
        <button className="detect-cli" type="button" onClick={retry}>Detect CLIs again</button>}
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
