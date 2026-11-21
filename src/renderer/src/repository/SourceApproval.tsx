import { useState } from 'react';
import type { ProviderId } from '../../../shared/domain';
import { PROVIDER_LABELS } from '../preferences';
import { errorMessage } from '../useRead';
import type { RepositoryCategory } from './repositoryApproval';

const categoryLabel = { map: 'map requests', change: 'change lesson requests' };

export function AlwaysAllowSource({ provider, category, checked, onChange }: {
  provider: ProviderId; category: RepositoryCategory; checked: boolean; onChange: (allowed: boolean) => void;
}) {
  return <label className="repository-permission">
    <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    Always allow {categoryLabel[category]} for this workspace with {PROVIDER_LABELS[provider]}
  </label>;
}

export function RevokeSourceApproval({ provider, category, onRevoke }: {
  provider: ProviderId; category: RepositoryCategory; onRevoke: () => void;
}) {
  const [error, setError] = useState('');
  return <div className="repository-permission-status">
    <p>Always allowed for {categoryLabel[category]} in this workspace with {PROVIDER_LABELS[provider]}.</p>
    <button type="button" onClick={() => {
      try { onRevoke(); }
      catch (cause) { setError('Could not revoke source approval. ' + errorMessage(cause)); }
    }}>Revoke always allow</button>
    {error && <p className="setup-error" role="alert">{error}</p>}
  </div>;
}
