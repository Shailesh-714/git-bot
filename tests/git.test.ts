import { describe, expect, it } from 'vitest';
import { extractPrUrl } from '../src/git.js';

function pushResult(all: string[], pullRequestUrl?: string) {
  return { remoteMessages: { all, pullRequestUrl } };
}

describe('extractPrUrl', () => {
  it('prefers the pullRequestUrl parsed by simple-git', () => {
    const result = pushResult([], 'https://github.com/owner/repo/pull/new/feature');
    expect(extractPrUrl(result)).toBe('https://github.com/owner/repo/pull/new/feature');
  });

  it('adds a scheme when simple-git strips it', () => {
    const result = pushResult([], 'github.com/owner/repo/pull/new/feature');
    expect(extractPrUrl(result)).toBe('https://github.com/owner/repo/pull/new/feature');
  });

  it('finds Bitbucket Server links in the remote messages', () => {
    const result = pushResult([
      'Create pull request for feature/foo:',
      'https://bitbucket.example.com/projects/ABC/repos/repo/pull-requests?create&sourceBranch=refs%2Fheads%2Ffeature%2Ffoo',
    ]);
    expect(extractPrUrl(result)).toBe(
      'https://bitbucket.example.com/projects/ABC/repos/repo/pull-requests?create&sourceBranch=refs%2Fheads%2Ffeature%2Ffoo',
    );
  });

  it('finds older Bitbucket Server compare links', () => {
    const result = pushResult([
      'Create pull request for feature/foo:',
      'https://bitbucket.example.com/projects/ABC/repos/repo/compare/commits?sourceBranch=refs%2Fheads%2Ffeature%2Ffoo',
    ]);
    expect(extractPrUrl(result)).toContain('/compare/commits');
  });

  it('finds GitLab merge request links', () => {
    const result = pushResult([
      'To create a merge request for feature/foo, visit:',
      'https://gitlab.example.com/group/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Ffoo',
    ]);
    expect(extractPrUrl(result)).toContain('/merge_requests/new');
  });

  it('falls back to the line after a create-pull-request announcement', () => {
    const result = pushResult([
      'Create pull request for feature/foo:',
      'https://proxy.example.com/bitbucket/custom/path?branch=feature%2Ffoo',
    ]);
    expect(extractPrUrl(result)).toBe(
      'https://proxy.example.com/bitbucket/custom/path?branch=feature%2Ffoo',
    );
  });

  it('handles the announcement and link on a single line', () => {
    const result = pushResult([
      'Create pull request for feature/foo: https://host.example.com/create?branch=feature%2Ffoo',
    ]);
    expect(extractPrUrl(result)).toBe('https://host.example.com/create?branch=feature%2Ffoo');
  });

  it('returns undefined when the push output has no link', () => {
    const result = pushResult(['Resolving deltas: 100% (3/3), done.']);
    expect(extractPrUrl(result)).toBeUndefined();
  });

  it('returns undefined when remoteMessages is missing', () => {
    expect(extractPrUrl({})).toBeUndefined();
  });
});
