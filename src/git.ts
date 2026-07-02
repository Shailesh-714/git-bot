import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import { DiffResult, GitBotError } from './types.js';

const UNTRACKED_PREVIEW_LINES = 12;

export function openRepo(repoPath?: string): SimpleGit {
  const basePath = repoPath ? path.resolve(repoPath) : process.cwd();
  const options: Partial<SimpleGitOptions> = {
    baseDir: basePath,
    binary: 'git',
    maxConcurrentProcesses: 6,
  };
  return simpleGit(options);
}

export async function getDiff(git: SimpleGit): Promise<DiffResult> {
  const staged = await git.diff(['--cached']);
  if (staged.trim()) {
    return { diff: staged, source: 'staged', hasChanges: true };
  }

  const unstaged = await git.diff();
  const untracked = await collectUntrackedFiles(git);

  const combined = [unstaged, untracked].filter(Boolean).join('\n');
  if (combined.trim()) {
    return { diff: combined, source: 'unstaged', hasChanges: true };
  }

  return { diff: '', source: 'none', hasChanges: false };
}

async function collectUntrackedFiles(git: SimpleGit): Promise<string> {
  const status = await git.status();
  const files = status.not_added;
  if (!files || files.length === 0) {
    return '';
  }

  const repoRoot = await git.revparse(['--show-toplevel']);
  const chunks: string[] = [];
  for (const filePath of files) {
    const fullPath = path.join(repoRoot, filePath);
    const chunk = await buildUntrackedChunk(fullPath, filePath);
    chunks.push(chunk);
  }
  return chunks.join('\n');
}

async function buildUntrackedChunk(
  fullPath: string,
  filePath: string,
): Promise<string> {
  try {
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) {
      return `# new file: ${filePath}`;
    }

    const text = await fs.readFile(fullPath, 'utf-8');
    const preview = limitLines(text, UNTRACKED_PREVIEW_LINES);
    const lineCount = preview.split('\n').length;

    return [
      `# new file: ${filePath}`,
      `--- /dev/null`,
      `+++ b/${filePath}`,
      `@@ -0,0 +1,${lineCount} @@`,
      preview,
    ].join('\n');
  } catch {
    return `# new file: ${filePath}`;
  }
}

function limitLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) {
    return text;
  }
  const kept = lines.slice(0, maxLines);
  return `${kept.join('\n')}\n... (${lines.length - maxLines} more lines)`;
}

export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add('-A');
}

export async function commit(git: SimpleGit, message: string): Promise<void> {
  try {
    await git.commit(message);
  } catch (error) {
    const stderr = String(error).toLowerCase();
    if (
      stderr.includes('author identity unknown') ||
      stderr.includes('empty ident name')
    ) {
      throw new GitBotError(
        'Git author identity is not configured.\n' +
          "Run the following commands and try again:\n\n" +
          "  git config --global user.name 'Your Name'\n" +
          "  git config --global user.email 'your.email@example.com'",
      );
    }
    throw new GitBotError(
      `Failed to create commit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function checkoutOrCreateBranch(
  git: SimpleGit,
  branchName: string,
): Promise<void> {
  const branches = await git.branchLocal();
  if (branches.all.includes(branchName)) {
    throw new GitBotError(`Branch '${branchName}' already exists.`);
  }
  await git.checkoutLocalBranch(branchName);
}

export async function isDirty(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return status.files.length > 0;
}
