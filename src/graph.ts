import { ChatOpenAI } from '@langchain/openai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Config } from './config.js';
import {
  buildBranchSystemPrompt,
  buildBranchUserPrompt,
  buildCombinedSystemPrompt,
  buildCombinedUserPrompt,
  buildCommitSystemPrompt,
  buildCommitUserPrompt,
} from './prompts.js';
import { BranchResult, CommitAndBranch, CommitResult, GenerationError } from './types.js';

const DEFAULT_DIFF_BUDGET_CHARS = 200_000;
const MIN_DIFF_BUDGET_CHARS = 8_000;
const MAX_GENERATION_ATTEMPTS = 3;

type GenerationMode = 'commit' | 'branch' | 'combined';

function buildLLM(config: Config) {
  return new ChatOpenAI({
    model: config.llm.model,
    apiKey: config.llm.apiKey,
    configuration: config.llm.baseUrl ? { baseURL: config.llm.baseUrl } : undefined,
    temperature: config.llm.temperature,
  });
}

function trimDiff(diff: string, budget: number): string {
  if (diff.length <= budget) {
    return diff;
  }
  const half = Math.floor(budget / 2);
  const head = diff.slice(0, half);
  const tail = diff.slice(-half);
  return `${head}\n\n... (${diff.length - budget} characters omitted) ...\n\n${tail}`;
}

function isLengthError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /length|max.?tokens|context length|too long|maximum context/i.test(msg);
}

function getCommitTypeEnum(config: Config): [string, ...string[]] {
  return config.conventions.commit.enabledTypes as [string, ...string[]];
}

function getBranchPrefixEnum(config: Config): [string, ...string[]] {
  return config.conventions.branch.enabledPrefixes as [string, ...string[]];
}

function buildCommitSchema(config: Config) {
  return z.object({
    type: z.enum(getCommitTypeEnum(config)).describe('One of the allowed commit types.'),
    summary: z
      .string()
      .describe(
        'Short imperative summary of the change, lowercase after type, no trailing period.',
      ),
  });
}

function buildBranchSchema(config: Config) {
  return z.object({
    prefix: z.enum(getBranchPrefixEnum(config)).describe('One of the allowed branch prefixes.'),
    name: z
      .string()
      .describe('Kebab-case descriptive name after the prefix, lowercase words separated by "-".'),
  });
}

function buildCombinedSchema(config: Config) {
  return z.object({
    type: z.enum(getCommitTypeEnum(config)).describe('One of the allowed commit types.'),
    summary: z
      .string()
      .describe(
        'Short imperative summary of the change, lowercase after type, no trailing period.',
      ),
    prefix: z.enum(getBranchPrefixEnum(config)).describe('One of the allowed branch prefixes.'),
    name: z
      .string()
      .describe('Kebab-case descriptive name after the prefix, lowercase words separated by "-".'),
  });
}

type StructuredModelResult<T> = { parsed: T } | { lengthError: true };

async function invokeStructuredModel<T>(
  schema: z.ZodType<T>,
  messages: BaseMessage[],
  config: Config,
): Promise<StructuredModelResult<T>> {
  const model = buildLLM(config).withStructuredOutput(schema, { includeRaw: true });

  try {
    const response = (await model.invoke(messages)) as {
      parsed?: T;
      parsing_error?: Error;
      raw: BaseMessage;
    };

    if (response.parsed) {
      return { parsed: response.parsed };
    }

    const parseError = response.parsing_error;
    if (isLengthError(parseError) || isLengthError(response.raw)) {
      return { lengthError: true };
    }

    const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(errorMessage);
  } catch (error) {
    if (isLengthError(error)) {
      return { lengthError: true };
    }
    // Transient errors (network, rate limits) are thrown so LangGraph's retry policy can catch them.
    throw error;
  }
}

function formatCommitMessage(parsed: CommitResult, config: Config): string {
  const cfg = config.conventions.commit;
  const allowed = new Set(cfg.enabledTypes.map((t) => t.toLowerCase()));
  const type = parsed.type.toLowerCase().trim();

  if (!allowed.has(type)) {
    throw new Error(`disallowed commit type '${type}'`);
  }

  const summary = parsed.summary.trim().replace(/\.$/, '');
  if (!summary) {
    throw new Error('empty commit summary');
  }

  const message = cfg.format.replace('{type}', type).replace('{summary}', summary);
  return message.length > cfg.maxLength ? message.slice(0, cfg.maxLength).trim() : message;
}

function formatBranchName(parsed: BranchResult, config: Config, issue?: string): string {
  const cfg = config.conventions.branch;
  const allowed = new Set(cfg.enabledPrefixes.map((p) => p.toLowerCase()));
  const prefix = parsed.prefix.toLowerCase().trim();

  if (!allowed.has(prefix)) {
    throw new Error(`disallowed branch prefix '${prefix}'`);
  }

  let name = parsed.name
    .trim()
    .toLowerCase()
    .replace(/[^\w-/]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const prefixWithSep = `${prefix}${cfg.separator}`;
  if (name.startsWith(prefixWithSep)) {
    name = name.slice(prefixWithSep.length).replace(/^-|-$/g, '');
  }

  if (!name) {
    throw new Error('empty branch name');
  }

  let branchName = `${prefix}${cfg.separator}${name}`;

  if (issue && !branchName.toLowerCase().includes(issue.toLowerCase())) {
    branchName = `${branchName}-${issue}`;
  }

  if (branchName.length > cfg.maxLength) {
    branchName = branchName.slice(0, cfg.maxLength).replace(/-$/, '');
  }

  return branchName;
}

function formatCommitAndBranch(
  parsed: CommitResult & BranchResult,
  config: Config,
  issue?: string,
): CommitAndBranch {
  return {
    commitMessage: formatCommitMessage(parsed, config),
    branchName: formatBranchName(parsed, config, issue),
  };
}

// ---------------------------------------------------------------------------
// Unified generation graph
// ---------------------------------------------------------------------------

const GenerationState = Annotation.Root({
  config: Annotation<Config>(),
  mode: Annotation<GenerationMode>(),
  diff: Annotation<string>(),
  issue: Annotation<string>(),
  diffBudgetChars: Annotation<number>(),
  preparedDiff: Annotation<string>(),
  messages: Annotation<BaseMessage[]>(),
  commitMessage: Annotation<string>(),
  branchName: Annotation<string>(),
  feedback: Annotation<string>(),
  attempts: Annotation<number>(),
});

async function prepareGeneration(state: typeof GenerationState.State) {
  const prepared = trimDiff(state.diff, state.diffBudgetChars);
  const { mode, config, issue, feedback } = state;

  let messages: BaseMessage[];
  if (mode === 'commit') {
    messages = [
      new SystemMessage(buildCommitSystemPrompt()),
      new HumanMessage(buildCommitUserPrompt(prepared, config, feedback)),
    ];
  } else if (mode === 'branch') {
    messages = [
      new SystemMessage(buildBranchSystemPrompt()),
      new HumanMessage(buildBranchUserPrompt(prepared, config, issue, feedback)),
    ];
  } else {
    messages = [
      new SystemMessage(buildCombinedSystemPrompt()),
      new HumanMessage(buildCombinedUserPrompt(prepared, config, issue, feedback)),
    ];
  }

  return { preparedDiff: prepared, messages };
}

async function generateGeneration(state: typeof GenerationState.State) {
  const { config, mode, messages } = state;

  if (mode === 'commit') {
    const result = await invokeStructuredModel(buildCommitSchema(config), messages, config);
    if ('lengthError' in result) {
      return reduceDiffBudget(state);
    }
    return finalizeCommit(state, result.parsed);
  }

  if (mode === 'branch') {
    const result = await invokeStructuredModel(buildBranchSchema(config), messages, config);
    if ('lengthError' in result) {
      return reduceDiffBudget(state);
    }
    return finalizeBranch(state, result.parsed);
  }

  const result = await invokeStructuredModel(buildCombinedSchema(config), messages, config);
  if ('lengthError' in result) {
    return reduceDiffBudget(state);
  }
  return finalizeCombined(state, result.parsed);
}

function finalizeCommit(state: typeof GenerationState.State, parsed: CommitResult) {
  try {
    const commitMessage = formatCommitMessage(parsed, state.config);
    return { commitMessage, feedback: undefined };
  } catch (error) {
    return validationFeedback(state, error instanceof Error ? error.message : String(error));
  }
}

function finalizeBranch(state: typeof GenerationState.State, parsed: BranchResult) {
  try {
    const branchName = formatBranchName(parsed, state.config, state.issue);
    return { branchName, feedback: undefined };
  } catch (error) {
    return validationFeedback(state, error instanceof Error ? error.message : String(error));
  }
}

function finalizeCombined(
  state: typeof GenerationState.State,
  parsed: CommitResult & BranchResult,
) {
  try {
    const { commitMessage, branchName } = formatCommitAndBranch(parsed, state.config, state.issue);
    return { commitMessage, branchName, feedback: undefined };
  } catch (error) {
    return validationFeedback(state, error instanceof Error ? error.message : String(error));
  }
}

async function finalizeGeneration(state: typeof GenerationState.State) {
  return {
    commitMessage: state.commitMessage,
    branchName: state.branchName,
  };
}

async function failGeneration(state: typeof GenerationState.State) {
  throw new GenerationError(
    state.feedback ||
      `Failed to generate a valid ${state.mode} result after ${MAX_GENERATION_ATTEMPTS} attempts.`,
  );
}

function reduceDiffBudget(state: typeof GenerationState.State) {
  const newBudget = Math.max(MIN_DIFF_BUDGET_CHARS, Math.floor(state.diffBudgetChars * 0.75));
  return {
    diffBudgetChars: newBudget,
    attempts: state.attempts + 1,
    feedback: `The diff context was too long for the model. Retrying with a shorter context (${newBudget} characters).`,
  };
}

function validationFeedback(state: typeof GenerationState.State, message: string) {
  return {
    feedback: message,
    attempts: state.attempts + 1,
  };
}

function routeAfterGeneration(
  state: typeof GenerationState.State,
): 'finalize' | 'fail' | 'prepare' {
  if (state.mode === 'commit' && state.commitMessage) {
    return 'finalize';
  }
  if (state.mode === 'branch' && state.branchName) {
    return 'finalize';
  }
  if (state.mode === 'combined' && state.commitMessage && state.branchName) {
    return 'finalize';
  }
  if (state.attempts >= MAX_GENERATION_ATTEMPTS) {
    return 'fail';
  }
  return 'prepare';
}

const generationGraph = new StateGraph(GenerationState)
  .addNode('prepare', prepareGeneration)
  .addNode('generate', generateGeneration, { retryPolicy: { maxAttempts: 3 } })
  .addNode('finalize', finalizeGeneration)
  .addNode('fail', failGeneration)
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'generate')
  .addConditionalEdges('generate', routeAfterGeneration, {
    finalize: 'finalize',
    fail: 'fail',
    prepare: 'prepare',
  })
  .addEdge('finalize', END)
  .compile();

export async function generateCommitMessage(diff: string, config: Config): Promise<string> {
  const result = await generationGraph.invoke({
    diff,
    config,
    mode: 'commit',
    issue: '',
    messages: [],
    attempts: 0,
    diffBudgetChars: DEFAULT_DIFF_BUDGET_CHARS,
  });
  if (!result.commitMessage) {
    throw new GenerationError('Commit generation returned no message.');
  }
  return result.commitMessage;
}

export async function generateBranchName(
  diff: string,
  config: Config,
  issue?: string,
): Promise<string> {
  const result = await generationGraph.invoke({
    diff,
    config,
    mode: 'branch',
    issue,
    messages: [],
    attempts: 0,
    diffBudgetChars: DEFAULT_DIFF_BUDGET_CHARS,
  });
  if (!result.branchName) {
    throw new GenerationError('Branch generation returned no name.');
  }
  return result.branchName;
}

export async function generateCommitAndBranch(
  diff: string,
  config: Config,
  issue?: string,
): Promise<CommitAndBranch> {
  const result = await generationGraph.invoke({
    diff,
    config,
    mode: 'combined',
    issue,
    messages: [],
    attempts: 0,
    diffBudgetChars: DEFAULT_DIFF_BUDGET_CHARS,
  });
  if (!result.commitMessage || !result.branchName) {
    throw new GenerationError('Combined generation returned incomplete results.');
  }
  return {
    commitMessage: result.commitMessage,
    branchName: result.branchName,
  };
}
