import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { GenerationError } from '../src/types.js';

const ChatOpenAI = vi.hoisted(() => vi.fn());

vi.mock('@langchain/openai', () => ({
  ChatOpenAI,
}));

import {
  generateBranchName,
  generateCommitAndBranch,
  generateCommitMessage,
} from '../src/graph.js';

function makeConfig(): Config {
  return {
    llm: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: 'test',
      baseUrl: '',
      temperature: 0.2,
    },
    conventions: {
      commit: {
        enabledTypes: ['feat', 'fix', 'docs'],
        format: '{type}: {summary}',
        maxLength: 50,
      },
      branch: {
        enabledPrefixes: ['feature', 'bugfix'],
        separator: '/',
        maxLength: 40,
      },
    },
  };
}

describe('generation graph', () => {
  beforeEach(() => {
    ChatOpenAI.mockClear();
  });

  it('generates a conventional commit message', async () => {
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => ({
          parsed: { type: 'feat', summary: 'add login form' },
        }),
      }),
    }));

    const message = await generateCommitMessage('some diff', makeConfig());
    expect(message).toBe('feat: add login form');
  });

  it('retries when the model returns an invalid type', async () => {
    let calls = 0;
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => {
          calls += 1;
          if (calls === 1) {
            return { parsed: { type: 'chore', summary: 'update deps' } };
          }
          return { parsed: { type: 'feat', summary: 'add auth' } };
        },
      }),
    }));

    const message = await generateCommitMessage('some diff', makeConfig());
    expect(message).toBe('feat: add auth');
    expect(calls).toBeGreaterThan(1);
  });

  it('truncates overly long commit messages to the configured limit', async () => {
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => ({
          parsed: {
            type: 'feat',
            summary: 'this is an extremely long summary that definitely exceeds fifty chars',
          },
        }),
      }),
    }));

    const message = await generateCommitMessage('some diff', makeConfig());
    expect(message.length).toBeLessThanOrEqual(50);
    expect(message.startsWith('feat:')).toBe(true);
  });

  it('generates a branch name and appends the issue identifier', async () => {
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => ({
          parsed: { prefix: 'feature', name: 'login-flow' },
        }),
      }),
    }));

    const branch = await generateBranchName('some diff', makeConfig(), 'PROJ-42');
    expect(branch).toBe('feature/login-flow-PROJ-42');
  });

  it('strips duplicate prefixes from the branch name', async () => {
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => ({
          parsed: { prefix: 'feature', name: 'feature/initial-setup' },
        }),
      }),
    }));

    const branch = await generateBranchName('some diff', makeConfig());
    expect(branch).toBe('feature/initial-setup');
  });

  it('fails gracefully after exhausting length-error retries', async () => {
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => ({
          parsed: null,
          parsing_error: new Error('context length exceeded, reduce input tokens'),
        }),
      }),
    }));

    await expect(generateCommitMessage('huge diff'.repeat(10_000), makeConfig())).rejects.toThrow(
      GenerationError,
    );
    expect(ChatOpenAI.mock.calls.length).toBeGreaterThan(1);
  });

  it('generates a commit message and branch name in a single call', async () => {
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => ({
          parsed: {
            type: 'feat',
            summary: 'add login form',
            prefix: 'feature',
            name: 'login-flow',
          },
        }),
      }),
    }));

    const result = await generateCommitAndBranch('some diff', makeConfig());
    expect(result.commitMessage).toBe('feat: add login form');
    expect(result.branchName).toBe('feature/login-flow');
  });

  it('appends the issue identifier to the combined branch name', async () => {
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => ({
          parsed: {
            type: 'fix',
            summary: 'resolve auth bug',
            prefix: 'bugfix',
            name: 'auth-token',
          },
        }),
      }),
    }));

    const result = await generateCommitAndBranch('some diff', makeConfig(), 'PROJ-42');
    expect(result.commitMessage).toBe('fix: resolve auth bug');
    expect(result.branchName).toBe('bugfix/auth-token-PROJ-42');
  });

  it('retries combined generation when the commit type is invalid', async () => {
    let calls = 0;
    ChatOpenAI.mockImplementation(() => ({
      withStructuredOutput: () => ({
        invoke: async () => {
          calls += 1;
          if (calls === 1) {
            return {
              parsed: {
                type: 'chore',
                summary: 'update deps',
                prefix: 'feature',
                name: 'deps-update',
              },
            };
          }
          return {
            parsed: { type: 'feat', summary: 'add auth', prefix: 'feature', name: 'auth-flow' },
          };
        },
      }),
    }));

    const result = await generateCommitAndBranch('some diff', makeConfig());
    expect(result.commitMessage).toBe('feat: add auth');
    expect(result.branchName).toBe('feature/auth-flow');
    expect(calls).toBeGreaterThan(1);
  });
});
