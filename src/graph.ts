import { ChatOpenAI } from '@langchain/openai';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Config } from './config.js';
import {
  buildBranchSystemPrompt,
  buildBranchUserPrompt,
  buildCommitSystemPrompt,
  buildCommitUserPrompt,
} from './prompts.js';
import { BranchResult, CommitResult, GenerationError } from './types.js';

const DEFAULT_DIFF_BUDGET_CHARS = 200_000;
const MIN_DIFF_BUDGET_CHARS = 8_000;
const MAX_GENERATION_ATTEMPTS = 3;

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

// ---------------------------------------------------------------------------
// Commit graph
// ---------------------------------------------------------------------------

const CommitState = Annotation.Root({
  config: Annotation<Config>(),
  diff: Annotation<string>(),
  diffBudgetChars: Annotation<number>(),
  preparedDiff: Annotation<string>(),
  messages: Annotation<BaseMessage[]>(),
  message: Annotation<string>(),
  feedback: Annotation<string>(),
  attempts: Annotation<number>(),
});

async function prepareCommit(state: typeof CommitState.State) {
  const prepared = trimDiff(state.diff, state.diffBudgetChars);
  const messages = [
    new SystemMessage(buildCommitSystemPrompt()),
    new HumanMessage(buildCommitUserPrompt(prepared, state.config, state.feedback)),
  ];
  return { preparedDiff: prepared, messages };
}

async function generateCommit(state: typeof CommitState.State) {
  const commitCfg = state.config.conventions.commit;
  const allowedTypes = commitCfg.enabledTypes as [string, ...string[]];

  const schema = z.object({
    type: z.enum(allowedTypes).describe('One of the allowed commit types.'),
    summary: z
      .string()
      .describe(
        'Short imperative summary of the change, lowercase after type, no trailing period.',
      ),
  });

  const model = buildLLM(state.config).withStructuredOutput(schema, { includeRaw: true });

  let response: {
    parsed?: CommitResult;
    parsing_error?: Error;
    raw: BaseMessage;
  };
  try {
    response = (await model.invoke(state.messages)) as typeof response;
  } catch (error) {
    if (isLengthError(error)) {
      return reduceDiffBudget(state);
    }
    // Transient errors (network, rate limits) are thrown so LangGraph's retry policy can catch them.
    throw error;
  }

  if (response.parsed) {
    try {
      const message = formatCommit(response.parsed, state.config);
      return { message, feedback: undefined };
    } catch (error) {
      return validationFeedback(
        state,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const parseError = response.parsing_error;
  const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);

  if (isLengthError(parseError) || isLengthError(response.raw)) {
    return reduceDiffBudget(state);
  }

  return validationFeedback(state, errorMessage);
}

function formatCommit(parsed: CommitResult, config: Config): string {
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

async function finalizeCommit(state: typeof CommitState.State) {
  return { message: state.message };
}

async function failCommit(state: typeof CommitState.State) {
  throw new GenerationError(
    state.feedback ||
      `Failed to generate a valid commit message after ${MAX_GENERATION_ATTEMPTS} attempts.`,
  );
}

function reduceDiffBudget(state: typeof CommitState.State) {
  const newBudget = Math.max(
    MIN_DIFF_BUDGET_CHARS,
    Math.floor(state.diffBudgetChars * 0.75),
  );
  return {
    diffBudgetChars: newBudget,
    attempts: state.attempts + 1,
    feedback: `The diff context was too long for the model. Retrying with a shorter context (${newBudget} characters).`,
  };
}

function validationFeedback(state: typeof CommitState.State, message: string) {
  return {
    feedback: message,
    attempts: state.attempts + 1,
  };
}

const commitGraph = new StateGraph(CommitState)
  .addNode('prepare', prepareCommit)
  .addNode('generate', generateCommit, { retryPolicy: { maxAttempts: 3 } })
  .addNode('finalize', finalizeCommit)
  .addNode('fail', failCommit)
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'generate')
  .addConditionalEdges(
    'generate',
    (state) => {
      if (state.message) return 'finalize';
      if (state.attempts >= MAX_GENERATION_ATTEMPTS) return 'fail';
      return 'prepare';
    },
    { finalize: 'finalize', fail: 'fail', prepare: 'prepare' },
  )
  .addEdge('finalize', END)
  .compile();

export async function generateCommitMessage(
  diff: string,
  config: Config,
): Promise<string> {
  const result = await commitGraph.invoke({
    diff,
    config,
    messages: [],
    attempts: 0,
    diffBudgetChars: DEFAULT_DIFF_BUDGET_CHARS,
  });
  if (!result.message) {
    throw new GenerationError('Commit generation returned no message.');
  }
  return result.message;
}

// ---------------------------------------------------------------------------
// Branch graph
// ---------------------------------------------------------------------------

const BranchState = Annotation.Root({
  config: Annotation<Config>(),
  diff: Annotation<string>(),
  issue: Annotation<string>(),
  diffBudgetChars: Annotation<number>(),
  preparedDiff: Annotation<string>(),
  messages: Annotation<BaseMessage[]>(),
  branchName: Annotation<string>(),
  feedback: Annotation<string>(),
  attempts: Annotation<number>(),
});

async function prepareBranch(state: typeof BranchState.State) {
  const prepared = trimDiff(state.diff, state.diffBudgetChars);
  const messages = [
    new SystemMessage(buildBranchSystemPrompt()),
    new HumanMessage(
      buildBranchUserPrompt(prepared, state.config, state.issue, state.feedback),
    ),
  ];
  return { preparedDiff: prepared, messages };
}

async function generateBranch(state: typeof BranchState.State) {
  const branchCfg = state.config.conventions.branch;
  const allowedPrefixes = branchCfg.enabledPrefixes as [string, ...string[]];

  const schema = z.object({
    prefix: z.enum(allowedPrefixes).describe('One of the allowed branch prefixes.'),
    name: z
      .string()
      .describe('Kebab-case descriptive name after the prefix, lowercase words separated by "-".'),
  });

  const model = buildLLM(state.config).withStructuredOutput(schema, { includeRaw: true });

  let response: {
    parsed?: BranchResult;
    parsing_error?: Error;
    raw: BaseMessage;
  };
  try {
    response = (await model.invoke(state.messages)) as typeof response;
  } catch (error) {
    if (isLengthError(error)) {
      return reduceBranchDiffBudget(state);
    }
    throw error;
  }

  if (response.parsed) {
    try {
      const branchName = formatBranch(response.parsed, state.config, state.issue);
      return { branchName, feedback: undefined };
    } catch (error) {
      return branchValidationFeedback(
        state,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const parseError = response.parsing_error;
  const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);

  if (isLengthError(parseError) || isLengthError(response.raw)) {
    return reduceBranchDiffBudget(state);
  }

  return branchValidationFeedback(state, errorMessage);
}

function formatBranch(parsed: BranchResult, config: Config, issue?: string): string {
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

async function finalizeBranch(state: typeof BranchState.State) {
  return { branchName: state.branchName };
}

async function failBranch(state: typeof BranchState.State) {
  throw new GenerationError(
    state.feedback ||
      `Failed to generate a valid branch name after ${MAX_GENERATION_ATTEMPTS} attempts.`,
  );
}

function reduceBranchDiffBudget(state: typeof BranchState.State) {
  const newBudget = Math.max(
    MIN_DIFF_BUDGET_CHARS,
    Math.floor(state.diffBudgetChars * 0.75),
  );
  return {
    diffBudgetChars: newBudget,
    attempts: state.attempts + 1,
    feedback: `The diff context was too long for the model. Retrying with a shorter context (${newBudget} characters).`,
  };
}

function branchValidationFeedback(state: typeof BranchState.State, message: string) {
  return {
    feedback: message,
    attempts: state.attempts + 1,
  };
}

const branchGraph = new StateGraph(BranchState)
  .addNode('prepare', prepareBranch)
  .addNode('generate', generateBranch, { retryPolicy: { maxAttempts: 3 } })
  .addNode('finalize', finalizeBranch)
  .addNode('fail', failBranch)
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'generate')
  .addConditionalEdges(
    'generate',
    (state) => {
      if (state.branchName) return 'finalize';
      if (state.attempts >= MAX_GENERATION_ATTEMPTS) return 'fail';
      return 'prepare';
    },
    { finalize: 'finalize', fail: 'fail', prepare: 'prepare' },
  )
  .addEdge('finalize', END)
  .compile();

export async function generateBranchName(
  diff: string,
  config: Config,
  issue?: string,
): Promise<string> {
  const result = await branchGraph.invoke({
    diff,
    config,
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
