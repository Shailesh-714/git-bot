import { describe, expect, it } from 'vitest';
import { buildPrCreationUrl, parseRemote } from '../src/pr.js';

describe('buildPrCreationUrl', () => {
  it('builds a compare URL from an HTTPS remote', () => {
    expect(buildPrCreationUrl('https://github.com/owner/repo.git', 'feature/login')).toBe(
      'https://github.com/owner/repo/compare/feature%2Flogin?expand=1',
    );
  });

  it('builds a compare URL from an SSH remote', () => {
    expect(buildPrCreationUrl('git@github.com:owner/repo.git', 'bugfix/crash')).toBe(
      'https://github.com/owner/repo/compare/bugfix%2Fcrash?expand=1',
    );
  });

  it('handles ssh:// style remotes', () => {
    expect(buildPrCreationUrl('ssh://git@github.com/owner/repo.git', 'feature/x')).toBe(
      'https://github.com/owner/repo/compare/feature%2Fx?expand=1',
    );
  });

  it('returns undefined for unrecognized remotes', () => {
    expect(buildPrCreationUrl('/local/bare/repo.git', 'feature/x')).toBeUndefined();
  });
});

describe('bitbucket server remotes', () => {
  it('detects HTTPS scm clone URLs', () => {
    const remote = parseRemote('https://bitbucket.example.com/scm/proj/my-repo.git');
    expect(remote).toEqual({
      provider: 'bitbucket-server',
      webUrl: 'https://bitbucket.example.com',
      projectKey: 'proj',
      repoSlug: 'my-repo',
    });
  });

  it('detects scm clone URLs behind a context path', () => {
    const remote = parseRemote('https://host.example.com/bitbucket/scm/proj/my-repo.git');
    expect(remote?.provider).toBe('bitbucket-server');
    expect(remote?.webUrl).toBe('https://host.example.com/bitbucket');
  });

  it('detects SSH remotes on port 7999', () => {
    const remote = parseRemote('ssh://git@bitbucket.example.com:7999/proj/my-repo.git');
    expect(remote).toEqual({
      provider: 'bitbucket-server',
      webUrl: 'https://bitbucket.example.com',
      projectKey: 'proj',
      repoSlug: 'my-repo',
    });
  });

  it('respects an explicit provider override for ambiguous remotes', () => {
    const remote = parseRemote('git@git.example.com:proj/my-repo.git', 'bitbucket-server');
    expect(remote?.provider).toBe('bitbucket-server');
    expect(remote?.projectKey).toBe('proj');
    expect(remote?.repoSlug).toBe('my-repo');
  });

  it('builds a Bitbucket Server PR creation URL', () => {
    expect(
      buildPrCreationUrl('https://bitbucket.example.com/scm/proj/my-repo.git', 'feature/login'),
    ).toBe(
      'https://bitbucket.example.com/projects/proj/repos/my-repo/pull-requests?create&sourceBranch=refs%2Fheads%2Ffeature%2Flogin',
    );
  });

  it('still treats plain SSH remotes as GitHub-style by default', () => {
    expect(buildPrCreationUrl('git@github.com:owner/repo.git', 'feature/x')).toBe(
      'https://github.com/owner/repo/compare/feature%2Fx?expand=1',
    );
  });
});
