import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
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

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function buildClient(config: Config): OpenAI {
  return new OpenAI({
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseUrl || undefined,
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
// Generation loop
// ---------------------------------------------------------------------------

const RESPONSE_FORMAT_NAMES: Record<GenerationMode, string> = {
  commit: 'commit_message',
  branch: 'branch_name',
  combined: 'commit_and_branch',
};

function buildMessages(
  mode: GenerationMode,
  preparedDiff: string,
  config: Config,
  issue?: string,
  feedback?: string,
): ChatMessage[] {
  if (mode === 'commit') {
    return [
      { role: 'system', content: buildCommitSystemPrompt() },
      { role: 'user', content: buildCommitUserPrompt(preparedDiff, config, feedback) },
    ];
  }
  if (mode === 'branch') {
    return [
      { role: 'system', content: buildBranchSystemPrompt() },
      { role: 'user', content: buildBranchUserPrompt(preparedDiff, config, issue, feedback) },
    ];
  }
  return [
    { role: 'system', content: buildCombinedSystemPrompt() },
    { role: 'user', content: buildCombinedUserPrompt(preparedDiff, config, issue, feedback) },
  ];
}

type ModelResult = { content: string } | { lengthError: true };

async function invokeModel(
  client: OpenAI,
  config: Config,
  mode: GenerationMode,
  schema: z.AnyZodObject,
  messages: ChatMessage[],
): Promise<ModelResult> {
  let completion: OpenAI.Chat.Completions.ChatCompletion;
  try {
    // Transient errors (network, rate limits) are retried by the SDK itself.
    completion = await client.chat.completions.create({
      model: config.llm.model ?? 'gpt-4o-mini',
      temperature: config.llm.temperature,
      messages,
      response_format: zodResponseFormat(schema, RESPONSE_FORMAT_NAMES[mode]),
    });
  } catch (error) {
    if (isLengthError(error)) {
      return { lengthError: true };
    }
    throw error;
  }

  const choice = completion.choices[0];
  if (!choice) {
    throw new GenerationError('Model returned no choices.');
  }
  if (choice.finish_reason === 'length') {
    return { lengthError: true };
  }
  if (choice.message.refusal) {
    throw new GenerationError(`Model refused to respond: ${choice.message.refusal}`);
  }
  return { content: choice.message.content ?? '' };
}

function parseContent<T>(content: string, schema: z.ZodType<T>): { value: T } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { error: `model returned invalid JSON: ${content.slice(0, 200)}` };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    return { error: `model output failed validation: ${issues}` };
  }
  return { value: parsed.data };
}

async function runGeneration<TSchema extends z.AnyZodObject, TOut>(
  config: Config,
  mode: GenerationMode,
  diff: string,
  issue: string | undefined,
  schema: TSchema,
  finalize: (parsed: z.infer<TSchema>) => TOut,
): Promise<TOut> {
  const client = buildClient(config);
  let diffBudgetChars = DEFAULT_DIFF_BUDGET_CHARS;
  let attempts = 0;
  let feedback: string | undefined;

  while (true) {
    const messages = buildMessages(mode, trimDiff(diff, diffBudgetChars), config, issue, feedback);
    let failure: string;

    const result = await invokeModel(client, config, mode, schema, messages);
    if ('lengthError' in result) {
      diffBudgetChars = Math.max(MIN_DIFF_BUDGET_CHARS, Math.floor(diffBudgetChars * 0.75));
      failure = `The diff context was too long for the model. Retrying with a shorter context (${diffBudgetChars} characters).`;
    } else {
      const parsed = parseContent(result.content, schema);
      if ('error' in parsed) {
        failure = parsed.error;
      } else {
        try {
          return finalize(parsed.value as z.infer<TSchema>);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
      }
    }

    attempts += 1;
    feedback = failure;
    if (attempts >= MAX_GENERATION_ATTEMPTS) {
      throw new GenerationError(failure);
    }
  }
}

export async function generateCommitMessage(diff: string, config: Config): Promise<string> {
  return runGeneration(config, 'commit', diff, undefined, buildCommitSchema(config), (parsed) =>
    formatCommitMessage(parsed, config),
  );
}

export async function generateBranchName(
  diff: string,
  config: Config,
  issue?: string,
): Promise<string> {
  return runGeneration(config, 'branch', diff, issue, buildBranchSchema(config), (parsed) =>
    formatBranchName(parsed, config, issue),
  );
}

export async function generateCommitAndBranch(
  diff: string,
  config: Config,
  issue?: string,
): Promise<CommitAndBranch> {
  return runGeneration(config, 'combined', diff, issue, buildCombinedSchema(config), (parsed) =>
    formatCommitAndBranch(parsed, config, issue),
  );
}
