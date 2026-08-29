import { describe, expect, it } from 'vitest';
import { parseRemote } from '../src/pr.js';

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
