import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, writeExampleConfig, configToToml } from '../src/config.js';

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-bot-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads user config from a TOML file', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `
[llm]
provider = "openai"
model = "gpt-4o-mini"
apiKey = "test-key"

[conventions.commit]
enabledTypes = ["feat", "fix", "docs"]
maxLength = 50

[conventions.branch]
enabledPrefixes = ["feature", "bugfix"]
separator = "/"
maxLength = 40
`,
    );

    const config = loadConfig(configPath);
    expect(config.llm.model).toBe('gpt-4o-mini');
    expect(config.llm.apiKey).toBe('test-key');
    expect(config.conventions.commit.enabledTypes).toEqual(['feat', 'fix', 'docs']);
    expect(config.conventions.commit.maxLength).toBe(50);
    expect(config.conventions.branch.enabledPrefixes).toEqual(['feature', 'bugfix']);
  });

  it('uses sensible defaults when no config exists', () => {
    const configPath = path.join(tmpDir, 'does-not-exist.toml');
    const config = loadConfig(configPath);
    expect(config.llm.provider).toBe('openai');
    expect(config.llm.model).toBe('gpt-4o-mini');
    expect(config.conventions.commit.enabledTypes).toContain('feat');
    expect(config.conventions.branch.enabledPrefixes).toContain('feature');
  });

  it('falls back to OPENAI_API_KEY environment variable', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    fs.writeFileSync(
      configPath,
      `
[llm]
apiKey = ""
`,
    );
    process.env.OPENAI_API_KEY = 'env-key';
    const config = loadConfig(configPath);
    expect(config.llm.apiKey).toBe('env-key');
    delete process.env.OPENAI_API_KEY;
  });

  it('writes a reloadable example config', () => {
    const configPath = path.join(tmpDir, 'generated.toml');
    writeExampleConfig(configPath);
    expect(fs.existsSync(configPath)).toBe(true);

    const reloaded = loadConfig(configPath);
    expect(reloaded.conventions.commit.enabledTypes).toEqual(
      expect.arrayContaining(['feat', 'fix']),
    );
  });

  it('round-trips config through TOML', () => {
    const config = loadConfig(path.join(tmpDir, 'missing.toml'));
    const toml = configToToml(config);
    const roundTripPath = path.join(tmpDir, 'roundtrip.toml');
    fs.writeFileSync(roundTripPath, toml);
    const reloaded = loadConfig(roundTripPath);
    expect(reloaded.conventions.commit.maxLength).toBe(config.conventions.commit.maxLength);
  });
});
