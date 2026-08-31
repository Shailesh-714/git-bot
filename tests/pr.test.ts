import { describe, expect, it } from 'vitest';
import { bitbucketPrCreationUrl, isGitHubPullNewUrl, parseRemote } from '../src/pr.js';

describe('parseRemote', () => {
  it('parses HTTPS GitHub remotes', () => {
    expect(parseRemote('https://github.com/owner/repo.git')).toEqual({
      provider: 'github',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('parses SSH GitHub remotes', () => {
    expect(parseRemote('git@github.com:owner/repo.git')).toEqual({
      provider: 'github',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('parses ssh:// style remotes', () => {
    expect(parseRemote('ssh://git@github.com/owner/repo.git')).toEqual({
      provider: 'github',
      webUrl: 'https://github.com/owner/repo',
    });
  });

  it('returns undefined for unrecognized remotes', () => {
    expect(parseRemote('/local/bare/repo.git')).toBeUndefined();
  });
});

describe('bitbucket server remotes', () => {
  it('detects HTTPS scm clone URLs', () => {
    expect(parseRemote('https://bitbucket.example.com/scm/proj/my-repo.git')).toEqual({
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
    expect(parseRemote('ssh://git@bitbucket.example.com:7999/proj/my-repo.git')).toEqual({
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

  it('still treats plain SSH remotes as GitHub-style by default', () => {
    expect(parseRemote('git@git.example.com:owner/repo.git')?.provider).toBe('github');
  });
});

describe('isGitHubPullNewUrl', () => {
  it('recognizes GitHub pull/new links', () => {
    expect(isGitHubPullNewUrl('https://github.com/owner/repo/pull/new/feature')).toBe(true);
  });

  it('rejects Bitbucket Server creation links', () => {
    expect(
      isGitHubPullNewUrl(
        'https://bitbucket.example.com/projects/ABC/repos/repo/pull-requests?create&sourceBranch=refs%2Fheads%2Ffeature',
      ),
    ).toBe(false);
  });

  it('rejects GitLab merge request links', () => {
    expect(
      isGitHubPullNewUrl('https://gitlab.example.com/group/repo/-/merge_requests/new'),
    ).toBe(false);
  });
});

describe('bitbucket data center remotes', () => {
  it('detects bitbucket hosts without scm paths or port 7999', () => {
    expect(parseRemote('ssh://git@ssh.bitbucket.example.net/hyp/my-infra.git')).toEqual({
      provider: 'bitbucket-server',
      webUrl: 'https://bitbucket.example.net',
      projectKey: 'hyp',
      repoSlug: 'my-infra',
    });
  });

  it('detects https bitbucket hosts', () => {
    expect(parseRemote('https://bitbucket.example.net/scm/hyp/my-infra.git')?.provider).toBe(
      'bitbucket-server',
    );
    expect(parseRemote('https://bitbucket.example.net/hyp/my-infra.git')?.provider).toBe(
      'bitbucket-server',
    );
  });

  it('leaves bitbucket.org (Cloud) alone', () => {
    expect(parseRemote('git@bitbucket.org:workspace/repo.git')?.provider).toBe('github');
  });
});

describe('bitbucketPrCreationUrl', () => {
  it('builds the creation page URL from the remote', () => {
    const remote = parseRemote('ssh://git@ssh.bitbucket.example.net/hyp/my-infra.git');
    expect(remote && bitbucketPrCreationUrl(remote, 'feature/foo')).toBe(
      'https://bitbucket.example.net/projects/HYP/repos/my-infra/pull-requests?create&sourceBranch=refs%2Fheads%2Ffeature%2Ffoo',
    );
  });

  it('returns undefined for github remotes', () => {
    const remote = parseRemote('https://github.com/owner/repo.git');
    expect(remote && bitbucketPrCreationUrl(remote, 'feature/foo')).toBeUndefined();
  });
});
