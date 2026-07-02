import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import * as TOML from 'smol-toml';

const DEFAULT_COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'style',
  'perf',
];

const DEFAULT_BRANCH_PREFIXES = ['feature', 'bugfix', 'hotfix', 'release'];

export const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'git-bot',
  'config.toml',
);

const llmConfigSchema = z.object({
  provider: z.literal('openai').default('openai'),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional().or(z.literal('')),
  temperature: z.number().min(0).max(2).default(0.2),
});

const commitConventionsSchema = z.object({
  enabledTypes: z.array(z.string()).default(() => [...DEFAULT_COMMIT_TYPES]),
  format: z.string().default('{type}: {summary}'),
  maxLength: z.number().positive().default(72),
});

const branchConventionsSchema = z.object({
  enabledPrefixes: z
    .array(z.string())
    .default(() => [...DEFAULT_BRANCH_PREFIXES]),
  separator: z.string().default('/'),
  maxLength: z.number().positive().default(60),
});

const configSchema = z.object({
  llm: llmConfigSchema.default({}),
  conventions: z
    .object({
      commit: commitConventionsSchema.default({}),
      branch: branchConventionsSchema.default({}),
    })
    .default({}),
});

export type Config = z.infer<typeof configSchema>;

function resolveConfigPath(provided?: string): string {
  if (provided) {
    return path.resolve(provided);
  }
  const envPath = process.env.GIT_BOT_CONFIG;
  if (envPath) {
    return path.resolve(envPath);
  }
  return DEFAULT_CONFIG_PATH;
}

function applyEnvironmentOverrides(config: Config): Config {
  const apiKey = config.llm.apiKey || process.env.OPENAI_API_KEY;
  const model = config.llm.model || 'gpt-4o-mini';
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey,
      model,
    },
  };
}

export function loadConfig(providedPath?: string): Config {
  const configPath = resolveConfigPath(providedPath);

  let raw: unknown = {};
  if (fs.existsSync(configPath)) {
    const content = fs.readFileSync(configPath, 'utf-8');
    raw = TOML.parse(content);
  }

  const parsed = configSchema.parse(raw);
  return applyEnvironmentOverrides(parsed);
}

function toTomlStringList(items: string[]): string {
  const inner = items.map((item) => `"${item}"`).join(', ');
  return `[${inner}]`;
}

export function exampleConfig(): Config {
  return {
    llm: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      apiKey: '',
      baseUrl: '',
      temperature: 0.2,
    },
    conventions: {
      commit: {
        enabledTypes: [...DEFAULT_COMMIT_TYPES],
        format: '{type}: {summary}',
        maxLength: 72,
      },
      branch: {
        enabledPrefixes: [...DEFAULT_BRANCH_PREFIXES],
        separator: '/',
        maxLength: 60,
      },
    },
  };
}

export function configToToml(config: Config): string {
  const lines = [
    '[llm]',
    `provider = "${config.llm.provider}"`,
    `model = "${config.llm.model}"`,
    'apiKey = "YOUR_API_KEY_HERE"',
    `baseUrl = "${config.llm.baseUrl ?? ''}"`,
    `temperature = ${config.llm.temperature}`,
    '',
    '[conventions.commit]',
    `enabledTypes = ${toTomlStringList(config.conventions.commit.enabledTypes)}`,
    `format = "${config.conventions.commit.format}"`,
    `maxLength = ${config.conventions.commit.maxLength}`,
    '',
    '[conventions.branch]',
    `enabledPrefixes = ${toTomlStringList(config.conventions.branch.enabledPrefixes)}`,
    `separator = "${config.conventions.branch.separator}"`,
    `maxLength = ${config.conventions.branch.maxLength}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function writeExampleConfig(destPath?: string): string {
  const writePath = destPath ? path.resolve(destPath) : DEFAULT_CONFIG_PATH;
  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, configToToml(exampleConfig()), 'utf-8');
  return writePath;
}
