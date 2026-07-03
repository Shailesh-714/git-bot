import type { Config } from './config.js';

const COMMIT_SYSTEM =
  'You are an expert developer assistant that writes concise, conventional git commit messages.';

const BRANCH_SYSTEM =
  'You are an expert developer assistant that creates concise, descriptive git branch names.';

const COMBINED_SYSTEM =
  'You are an expert developer assistant that writes conventional git commit messages and creates concise, descriptive git branch names.';

export function buildCommitUserPrompt(diff: string, config: Config, feedback?: string): string {
  const commitCfg = config.conventions.commit;
  const allowed = commitCfg.enabledTypes.join(', ');

  const parts = [
    `Allowed commit types: ${allowed}.`,
    `Format: ${commitCfg.format}`,
    `Maximum length: ${commitCfg.maxLength} characters.`,
    'Use imperative mood, keep the summary lowercase after the type, and do not end with a period.',
    '',
    'Write a commit message for the following git diff.',
    '',
    '```diff',
    diff,
    '```',
  ];

  if (feedback) {
    parts.push('', `Previous attempt failed validation: ${feedback}`, 'Please fix it.');
  }

  return parts.join('\n');
}

export function buildBranchUserPrompt(
  diff: string,
  config: Config,
  issue?: string,
  feedback?: string,
): string {
  const branchCfg = config.conventions.branch;
  const allowed = branchCfg.enabledPrefixes.join(', ');
  const issueHint = issue
    ? ` Include the issue identifier '${issue}' in the branch name if it fits naturally.`
    : '';

  const parts = [
    `Allowed branch prefixes: ${allowed}.`,
    `Separator: '${branchCfg.separator}'`,
    `Maximum length: ${branchCfg.maxLength} characters.`,
    'Use kebab-case after the prefix (lowercase words separated by hyphens).',
    `${issueHint}`,
    '',
    'Write a branch name for the following git diff.',
    '',
    '```diff',
    diff,
    '```',
  ];

  if (feedback) {
    parts.push('', `Previous attempt failed validation: ${feedback}`, 'Please fix it.');
  }

  return parts.join('\n');
}

export function buildCombinedUserPrompt(
  diff: string,
  config: Config,
  issue?: string,
  feedback?: string,
): string {
  const commitCfg = config.conventions.commit;
  const branchCfg = config.conventions.branch;
  const allowedCommitTypes = commitCfg.enabledTypes.join(', ');
  const allowedBranchPrefixes = branchCfg.enabledPrefixes.join(', ');
  const issueHint = issue
    ? ` Include the issue identifier '${issue}' in the branch name if it fits naturally.`
    : '';

  const parts = [
    'Produce a conventional commit message and a matching git branch name for the following diff.',
    '',
    'Commit rules:',
    `- Allowed commit types: ${allowedCommitTypes}.`,
    `- Format: ${commitCfg.format}`,
    `- Maximum length: ${commitCfg.maxLength} characters.`,
    '- Use imperative mood, keep the summary lowercase after the type, and do not end with a period.',
    '',
    'Branch rules:',
    `- Allowed branch prefixes: ${allowedBranchPrefixes}.`,
    `- Separator: '${branchCfg.separator}'`,
    `- Maximum length: ${branchCfg.maxLength} characters.`,
    '- Use kebab-case after the prefix (lowercase words separated by hyphens).',
    `${issueHint}`,
    '',
    '```diff',
    diff,
    '```',
  ];

  if (feedback) {
    parts.push('', `Previous attempt failed validation: ${feedback}`, 'Please fix it.');
  }

  return parts.join('\n');
}

export function buildCommitSystemPrompt(): string {
  return COMMIT_SYSTEM;
}

export function buildBranchSystemPrompt(): string {
  return BRANCH_SYSTEM;
}

export function buildCombinedSystemPrompt(): string {
  return COMBINED_SYSTEM;
}
