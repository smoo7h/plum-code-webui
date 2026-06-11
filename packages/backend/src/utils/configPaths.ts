import os from 'os';
import path from 'path';

// Precedence for the Claude config home (the `.claude` directory):
//   1. CLAUDE_CONFIG_DIR  — official Claude Code override (points AT the config dir)
//   2. WEBUI_CONFIG_HOME / CLAUDE_CONFIG_HOME — plum/legacy overrides
//   3. ~/.claude          — default
const CLAUDE_CONFIG_OVERRIDE =
  process.env.CLAUDE_CONFIG_DIR ||
  process.env.WEBUI_CONFIG_HOME ||
  process.env.CLAUDE_CONFIG_HOME;

export function resolveConfigHome(_provider?: unknown): string {
  const homeDir = os.homedir();

  return CLAUDE_CONFIG_OVERRIDE
    ? path.resolve(CLAUDE_CONFIG_OVERRIDE)
    : path.join(homeDir, '.claude');
}

// Resolve the global Claude settings.json path, honoring CLAUDE_CONFIG_DIR.
export function resolveClaudeSettingsPath(): string {
  return path.join(resolveConfigHome(), 'settings.json');
}
