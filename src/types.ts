export class GitBotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitBotError';
  }
}

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GenerationError';
  }
}

export interface DiffResult {
  diff: string;
  source: 'staged' | 'unstaged' | 'none';
  hasChanges: boolean;
}

export interface CommitResult {
  type: string;
  summary: string;
}

export interface BranchResult {
  prefix: string;
  name: string;
}

export interface CommitAndBranch {
  commitMessage: string;
  branchName: string;
}
