import { describe, expect, it } from 'vitest';
import { distinctWarnings } from './history';

describe('history warnings', () => {
  it('collapses repeated login advice and keeps distinct recovery steps', () => {
    const login = 'Run gh auth login to read GitHub pull requests.';
    const install = 'Install GitHub CLI and run gh auth login to read this repository.';
    const shallow = 'Git history is limited to this shallow snapshot. Run git fetch --unshallow to see older commits.';
    expect(distinctWarnings([login, install, login, shallow, 'Run gh auth login and make sure the account can read this repository.']))
      .toEqual([login, install, shallow]);
  });

  it('keeps login advice that also reports the local snapshot, in either order', () => {
    const login = 'Run gh auth login to read GitHub pull requests.';
    const snapshot = 'Run gh auth login and make sure the account can read this repository. Showing the last local snapshot.';
    expect(distinctWarnings([login, snapshot])).toEqual([login, snapshot]);
    expect(distinctWarnings([snapshot, login])).toEqual([snapshot, login]);
  });

  it('collapses equivalent install advice and identical other warnings', () => {
    const snapshot = 'Could not refresh the snapshot. Showing the last local snapshot.';
    expect(distinctWarnings(['Install GitHub CLI and run gh auth login to read this repository.', snapshot,
      'Install GitHub CLI and run gh auth login.', snapshot]))
      .toEqual(['Install GitHub CLI and run gh auth login to read this repository.', snapshot]);
  });
});
