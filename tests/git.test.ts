import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkoutOrCreateBranch, commit, getDiff, openRepo, stageAll } from '../src/git.js';
import { GitBotError } from '../src/types.js';

describe('git helpers', () => {
  let tmpDir: string;
  let repoPath: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-bot-'));
    repoPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoPath);

    const git = openRepo(repoPath);
    await git.init();
    await git.addConfig('user.name', 'Test User');
    await git.addConfig('user.email', 'test@example.com');

    const readme = path.join(repoPath, 'README.md');
    fs.writeFileSync(readme, 'hello', 'utf-8');
    await git.add(readme);
    await git.commit('Initial commit');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prefers staged changes', async () => {
    const git = openRepo(repoPath);
    const file = path.join(repoPath, 'README.md');
    fs.writeFileSync(file, 'hello world', 'utf-8');
    await git.add(file);

    const diff = await getDiff(git);
    expect(diff.source).toBe('staged');
    expect(diff.hasChanges).toBe(true);
    expect(diff.diff).toContain('hello world');
  });

  it('falls back to unstaged changes', async () => {
    const git = openRepo(repoPath);
    const file = path.join(repoPath, 'README.md');
    fs.writeFileSync(file, 'changed', 'utf-8');

    const diff = await getDiff(git);
    expect(diff.source).toBe('unstaged');
    expect(diff.hasChanges).toBe(true);
    expect(diff.diff).toContain('changed');
  });

  it('includes untracked files in the diff', async () => {
    const git = openRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, 'new-file.ts'), 'const x = 1;', 'utf-8');

    const diff = await getDiff(git);
    expect(diff.source).toBe('unstaged');
    expect(diff.hasChanges).toBe(true);
    expect(diff.diff).toContain('new file: new-file.ts');
    expect(diff.diff).toContain('const x = 1;');
  });

  it('detects no changes', async () => {
    const git = openRepo(repoPath);
    const diff = await getDiff(git);
    expect(diff.hasChanges).toBe(false);
  });

  it('stages all changes and commits', async () => {
    const git = openRepo(repoPath);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'updated', 'utf-8');

    await stageAll(git);
    await commit(git, 'chore: update readme');

    const log = await git.log({ n: 1 });
    expect(log.latest?.message).toBe('chore: update readme');
  });

  it('creates and checks out a new branch', async () => {
    const git = openRepo(repoPath);
    await checkoutOrCreateBranch(git, 'feature/new-stuff');
    const branches = await git.branchLocal();
    expect(branches.current).toBe('feature/new-stuff');
  });

  it('throws when a branch already exists', async () => {
    const git = openRepo(repoPath);
    await checkoutOrCreateBranch(git, 'feature/new-stuff');
    await expect(checkoutOrCreateBranch(git, 'feature/new-stuff')).rejects.toThrow(
      GitBotError,
    );
  });
});
