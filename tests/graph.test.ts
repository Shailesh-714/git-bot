import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { GenerationError } from '../src/types.js';

const createMock = vi.hoisted(() => vi.fn());
const OpenAIMock = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: OpenAIMock,
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

function completionWith(payload: unknown, finishReason = 'stop') {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: { content: JSON.stringify(payload), refusal: null },
      },
    ],
  };
}

describe('generation', () => {
  beforeEach(() => {
    createMock.mockReset();
    OpenAIMock.mockReset();
    OpenAIMock.mockImplementation(() => ({
      chat: { completions: { create: createMock } },
    }));
  });

  it('generates a conventional commit message', async () => {
    createMock.mockResolvedValue(completionWith({ type: 'feat', summary: 'add login form' }));

    const message = await generateCommitMessage('some diff', makeConfig());
    expect(message).toBe('feat: add login form');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('retries with feedback when the model returns an invalid type', async () => {
    createMock
      .mockResolvedValueOnce(completionWith({ type: 'chore', summary: 'update deps' }))
      .mockResolvedValueOnce(completionWith({ type: 'feat', summary: 'add auth' }));

    const message = await generateCommitMessage('some diff', makeConfig());
    expect(message).toBe('feat: add auth');
    expect(createMock).toHaveBeenCalledTimes(2);

    const retryRequest = createMock.mock.calls[1][0];
    const userMessage = retryRequest.messages.find(
      (m: { role: string; content: string }) => m.role === 'user',
    );
    expect(userMessage.content).toContain('Previous attempt failed validation');
  });

  it('retries when the model returns invalid JSON', async () => {
    createMock
      .mockResolvedValueOnce({
        choices: [{ finish_reason: 'stop', message: { content: 'not json', refusal: null } }],
      })
      .mockResolvedValueOnce(completionWith({ type: 'fix', summary: 'resolve crash' }));

    const message = await generateCommitMessage('some diff', makeConfig());
    expect(message).toBe('fix: resolve crash');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('truncates overly long commit messages to the configured limit', async () => {
    createMock.mockResolvedValue(
      completionWith({
        type: 'feat',
        summary: 'this is an extremely long summary that definitely exceeds fifty chars',
      }),
    );

    const message = await generateCommitMessage('some diff', makeConfig());
    expect(message.length).toBeLessThanOrEqual(50);
    expect(message.startsWith('feat:')).toBe(true);
  });

  it('generates a branch name and appends the issue identifier', async () => {
    createMock.mockResolvedValue(completionWith({ prefix: 'feature', name: 'login-flow' }));

    const branch = await generateBranchName('some diff', makeConfig(), 'PROJ-42');
    expect(branch).toBe('feature/login-flow-PROJ-42');
  });

  it('strips duplicate prefixes from the branch name', async () => {
    createMock.mockResolvedValue(
      completionWith({ prefix: 'feature', name: 'feature/initial-setup' }),
    );

    const branch = await generateBranchName('some diff', makeConfig());
    expect(branch).toBe('feature/initial-setup');
  });

  it('retries with feedback when the generated branch name already exists', async () => {
    createMock
      .mockResolvedValueOnce(completionWith({ prefix: 'feature', name: 'login-flow' }))
      .mockResolvedValueOnce(completionWith({ prefix: 'feature', name: 'login-flow-v2' }));

    const branch = await generateBranchName('some diff', makeConfig(), undefined, [
      'main',
      'feature/login-flow',
    ]);
    expect(branch).toBe('feature/login-flow-v2');
    expect(createMock).toHaveBeenCalledTimes(2);

    const retryRequest = createMock.mock.calls[1][0];
    const userMessage = retryRequest.messages.find(
      (m: { role: string; content: string }) => m.role === 'user',
    );
    expect(userMessage.content).toContain("branch 'feature/login-flow' already exists");

    const firstRequest = createMock.mock.calls[0][0];
    const firstUserMessage = firstRequest.messages.find(
      (m: { role: string; content: string }) => m.role === 'user',
    );
    expect(firstUserMessage.content).toContain('Existing branches: main, feature/login-flow');
  });

  it('shrinks the diff budget when the response is cut off by length', async () => {
    createMock
      .mockResolvedValueOnce(completionWith({}, 'length'))
      .mockResolvedValueOnce(completionWith({ type: 'feat', summary: 'add auth' }));

    const message = await generateCommitMessage('huge diff '.repeat(50_000), makeConfig());
    expect(message).toBe('feat: add auth');
    expect(createMock).toHaveBeenCalledTimes(2);

    const firstDiff = createMock.mock.calls[0][0].messages[1].content as string;
    const secondDiff = createMock.mock.calls[1][0].messages[1].content as string;
    expect(secondDiff.length).toBeLessThan(firstDiff.length);
  });

  it('fails gracefully after exhausting length-error retries', async () => {
    createMock.mockRejectedValue(new Error('context length exceeded, reduce input tokens'));

    await expect(generateCommitMessage('huge diff'.repeat(10_000), makeConfig())).rejects.toThrow(
      GenerationError,
    );
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('propagates transient errors without wrapping them', async () => {
    createMock.mockRejectedValue(new Error('connection reset'));

    await expect(generateCommitMessage('some diff', makeConfig())).rejects.toThrow(
      'connection reset',
    );
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('generates a commit message and branch name in a single call', async () => {
    createMock.mockResolvedValue(
      completionWith({
        type: 'feat',
        summary: 'add login form',
        prefix: 'feature',
        name: 'login-flow',
      }),
    );

    const result = await generateCommitAndBranch('some diff', makeConfig());
    expect(result.commitMessage).toBe('feat: add login form');
    expect(result.branchName).toBe('feature/login-flow');
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('appends the issue identifier to the combined branch name', async () => {
    createMock.mockResolvedValue(
      completionWith({
        type: 'fix',
        summary: 'resolve auth bug',
        prefix: 'bugfix',
        name: 'auth-token',
      }),
    );

    const result = await generateCommitAndBranch('some diff', makeConfig(), 'PROJ-42');
    expect(result.commitMessage).toBe('fix: resolve auth bug');
    expect(result.branchName).toBe('bugfix/auth-token-PROJ-42');
  });

  it('retries combined generation when the commit type is invalid', async () => {
    createMock
      .mockResolvedValueOnce(
        completionWith({
          type: 'chore',
          summary: 'update deps',
          prefix: 'feature',
          name: 'deps-update',
        }),
      )
      .mockResolvedValueOnce(
        completionWith({ type: 'feat', summary: 'add auth', prefix: 'feature', name: 'auth-flow' }),
      );

    const result = await generateCommitAndBranch('some diff', makeConfig());
    expect(result.commitMessage).toBe('feat: add auth');
    expect(result.branchName).toBe('feature/auth-flow');
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});
