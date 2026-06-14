# Spec: "steve" — a config-clone of the WebUI

**Date:** 2026-06-14
**Status:** Approved design, pending implementation plan
**Author:** brainstormed with the user

## Goal

Stand up a second instance of the Claude Code WebUI that is identical to the
existing CRM sandbox **except** for three things:

1. A different default working directory for Claude Code sessions
   (`/home/smooth/github/steve_project`).
2. A different MCP tool set — drop the CRM bridges, carry the dev tools from this
   WSL machine's global Claude install instead.
3. Full parity with this machine's global Claude **plugins and skills**.

Plus one explicit requirement: the workspace `CLAUDE.md` must stay empty and must
never contain the CRM project's instructions.

## Approach

**Config-only clone — no code fork.** A second container runs off the existing
`claude-code-webui:latest` image with its own isolated state (DB, config home,
workspace). Everything per-deployment is overridden via environment variables and
named bind mounts, which is exactly how this fork is already parameterized
(`docker-compose.yml` defaults driven by `DATA_DIR`, `CONFIG_DIR`, `WORKSPACE_DIR`,
`ALLOWED_BASE_PATHS`, port, container name).

The **only** code change is one env-gated flag (see §7) — default off, so the CRM
sandbox is functionally unaffected. Because that flag ships in image code, the
shared image is rebuilt **once** to bake it in; both containers then run the same
updated image (the CRM one behaves identically because the flag defaults off).

The clone is deployed from a **separate directory** (`~/github/steve-webui/`) so the
CRM repo stays untouched. That directory holds its own `docker-compose.yml`,
`.env`, `config/`, and `data/`, and reuses the (rebuilt) `claude-code-webui:latest`
image — no second image, no separate build pipeline.

### Why this works

All per-deployment state in this fork is env vars + bind-mounted volumes. The image
itself is generic. Two containers off the same image with different
`DATA_DIR`/`CONFIG_DIR`/`WORKSPACE_DIR`/port share nothing. `CONFIG_DIR` is a bind
mount that shadows the image's `/home/node/.claude`, so the clone's config home
starts empty and is **pre-populated** by a seed script — which is precisely the hook
we need for plugins/skills/MCP parity.

## 1. Container / isolation

| Knob | CRM sandbox | steve clone |
| --- | --- | --- |
| Image | `claude-code-webui:latest` | same image (rebuilt once to bake the §7 flag, then reused) |
| Container name | `claude-code-webui` | `claude-code-webui-steve` |
| Host port | `4545:3001` | `4546:3001` |
| `DATA_DIR` (DB/sessions) | `./data` | `~/github/steve-webui/data` |
| `CONFIG_DIR` (`~/.claude` etc.) | `./config` | `~/github/steve-webui/config` |
| `WORKSPACE_DIR` → `/workspace` | `./workspace` | `/home/smooth/github/steve_project` |
| Compose project name | (default) | `steve-webui` (isolated, no collision) |

Separate DB + config + workspace ⇒ the two instances share nothing: different MCP
tools, different Claude login, different default dir, no cross-talk.

`SESSION_SECRET` / `JWT_SECRET` are generated fresh for the clone's `.env`.

## 2. Default directory

- `ALLOWED_BASE_PATHS=/workspace` (unchanged from the fork default).
- `/home/smooth/github/steve_project` bind-mounts to `/workspace` in the container.
- The per-user default working directory (`user_settings.default_working_dir`, a
  SQLite value that is `null` until set) is configured to `/workspace` via the
  clone's Settings UI after first boot. New sessions then land in
  `/workspace/<session-name>`.

## 3. Plugins + skills (full parity with this WSL install)

A seed script copies from the host's global `~/.claude` into
`steve-webui/config/claude/`:

- **`skills/`** (~136 MB) — copied with symlink dereference (`cp -rL` / `rsync -L`)
  so the real content lands, not dangling links. (The host's `~/.claude/skills`
  contains symlinks into `~/.agents/skills`; the container later re-symlinks
  `~/.agents/skills → ~/.claude/skills`, so both Claude and Codex see the skills.)
- **`plugins/`** (~364 MB) — all 5 marketplaces (`claude-plugins-official`,
  `openai-codex`, `superpowers-marketplace`, `ui-ux-pro-max-skill`, `docker`),
  plus `installed_plugins.json` and `known_marketplaces.json`, and the ~620
  plugin-provided skills.
- A **curated `settings.json`** containing only:
  - `enabledPlugins` (mirrors this machine's enabled set)
  - `extraKnownMarketplaces`
  - `mcpServers` (see §4)
  - optionally `model` / `effortLevel`

  Deliberately **excluded** from the copied settings: `hooks`, `statusLine`,
  `permissions`, and other keys that reference local WSL paths/scripts and would
  break or misbehave inside the container.

The fork's runtime skill-sync (`skillSync.ts`, sourced from `/mnt/user/AI/Skills`
etc.) is a no-op in the clone because those host dirs are not mounted — the clone
relies entirely on the seeded config.

### Permissions note

The container runs as the `node` user. Seeded `config/` files must be readable by
that user; the seed script aligns ownership (uid match or `chown`) the same way the
CRM bind mount already works.

## 4. MCP servers (full parity, keys wired)

Registered in the seeded `settings.json` `mcpServers` block. The Claude CLI is
launched with `--mcp-config <~/.claude/settings.json>` (`resolveClaudeSettingsPath`),
so this block is the entire tool surface.

| Server | Transport | Auth / dependency |
| --- | --- | --- |
| `github` | **HTTP** (`https://api.githubcopilot.com/mcp/`) | `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}` — `${VAR}` expanded by the CLI from container env (GitHub PAT) |
| `playwright` | `npx -y @playwright/mcp@latest` | bundled `/usr/local/bin/plum-chromium` (reuses the `PLAYWRIGHT_*` env the compose already sets, inherited by the stdio child) |
| `firecrawl` | `npx -y firecrawl-mcp` (the standalone npm MCP, **not** the firecrawl plugin) | `FIRECRAWL_API_KEY` inherited from container env |
| `context7` | `npx -y @upstash/context7-mcp` | optional `CONTEXT7_API_KEY` (works keyless; blank left in `.env` for higher limits) |

These are the values resolved during planning (verified against the host plugin
`.mcp.json` files). Three facts drove the corrections from the first draft:

1. The Claude CLI as launched by this fork **does not auto-load plugin MCP servers**
   — only claude.ai-managed MCPs and project-local `.mcp.json` register by default
   (`ClaudeProcessManager.ts:2189-2193`). Every MCP we want active must therefore be
   listed explicitly in the seeded `settings.json` `mcpServers`, which the CLI reads
   via `--mcp-config`. Enabled plugins still contribute their **skills/commands**; only
   their **tool servers** need this explicit registration.
2. `github` is an **HTTP** server, not stdio, and reads `GITHUB_PERSONAL_ACCESS_TOKEN`.
3. The `firecrawl` plugin ships **skills only** (no `.mcp.json`); the live Firecrawl
   tools on this machine come from the OAuth-bound claude.ai connector, which is not
   clonable. To give the clone real Firecrawl tools we register the standalone
   `firecrawl-mcp` npm package instead.

stdio children inherit the full container environment (the spawn uses
`{ ...process.env }`, `ClaudeProcessManager.ts:2248`), so `FIRECRAWL_API_KEY` /
`CONTEXT7_API_KEY` set in compose reach the MCP child with no per-server `env` block.

`.env` placeholders for `GITHUB_PERSONAL_ACCESS_TOKEN` and `FIRECRAWL_API_KEY` are
left clearly marked for the user to paste in.

**Excluded:** CRM bridges (`comfyui`, `android-builder`, `vocarium`), `windows-mcp`
(Windows-desktop control — dead in a Linux container), `serena` (user deselected),
`codex` (the `codex` plugin is a command plugin with **no** MCP server — Codex stays
available as a WebUI *CLI provider*, just not as an MCP tool), and the claude.ai
account connectors (Gmail/Calendar/Drive/Pulsechain/bluffnet — OAuth, not
file-clonable).

## 5. Secrets / hygiene

- Copy **only** `skills/` + `plugins/` + the curated `settings.json`.
- **Never** copy: `~/.claude/.credentials.json` (claude.ai OAuth — the clone does
  its own `/login`), `history.jsonl`, `projects/`, `debug/`, `file-history/`,
  `paste-cache/`, `.serena/`, `channels/`, `remote/`, `ide/`, `backups/`.
- **Do not** copy the host's global `~/.claude/CLAUDE.md` (the user's personal
  "Process skills first / Superpowers" instructions).
- `.env` for the clone (PAT + Firecrawl key) is gitignored.

## 6. CLAUDE.md handling (empty workspace file)

The CRM project's `CLAUDE.md` lives at
`/home/smooth/github/plum-code-webui/CLAUDE.md` — a separate directory from the
clone's workspace (`/home/smooth/github/steve_project`). It is never copied to or
read from the workspace, so "none of the CRM one" is guaranteed by directory
separation alone.

The only thing the backend would otherwise write into the workspace `CLAUDE.md` is a
small auto-generated **project-context block** (folder name + detected stack),
produced by `ensureProjectInstructions` (`ClaudeProcessManager.ts:841`). To honor
the "empty" requirement, the clone suppresses that write (see §7).

The global `~/.claude/CLAUDE.md` skills/plugins registry block (written by the same
manager around line 1875) is left enabled — it is a useful index, not user
instructions, and was not part of the concern.

## 7. The one code change: `WEBUI_DISABLE_PROJECT_CLAUDE_MD`

Add an env-gated flag that skips the workspace project-context write:

- `config.ts`: add an optional boolean (default `false`) parsed from
  `WEBUI_DISABLE_PROJECT_CLAUDE_MD`.
- `ClaudeProcessManager.ts` (call site ~line 1875): wrap the
  `ensureProjectInstructions(...)` call so it is skipped when the flag is set. The
  global registry write is left untouched.

Default off ⇒ the CRM sandbox behaves exactly as today. The clone sets
`WEBUI_DISABLE_PROJECT_CLAUDE_MD=1`, so `steve_project/CLAUDE.md` stays empty/absent.

This is the **only** change to shared image code; it ships in the image but is inert
unless the env var is set.

## 8. One-time setup (after `docker compose up -d`)

1. Open `http://localhost:4546`; configure basic-auth / log in.
2. Run Claude `/login` in the clone (its config volume is fresh — separate from the
   CRM login).
3. Settings → set default working directory = `/workspace`.
4. Paste GitHub PAT + `FIRECRAWL_API_KEY` into the clone's `.env`, then restart.

## Out of scope

- No changes to the CRM sandbox deployment.
- No new image or separate build pipeline; the shared `claude-code-webui:latest` is
  rebuilt once (for the §7 flag) and reused by both containers.
- No migration of claude.ai account connectors (technically not clonable).
- No copying of host hooks/statusLine/permissions/personal history.

## Open implementation details (resolved during planning)

- **Resolved.** `github` = HTTP MCP at `https://api.githubcopilot.com/mcp/`, auth
  header `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`. `firecrawl` =
  standalone `npx -y firecrawl-mcp`, env `FIRECRAWL_API_KEY`. `playwright` =
  `npx -y @playwright/mcp@latest`. `context7` = `npx -y @upstash/context7-mcp`
  (optional `CONTEXT7_API_KEY`). All four are declared in the seeded
  `settings.json` `mcpServers` block (see §4).
- **Resolved.** Image stays on `:latest`; the clone runs the same locally-built
  `claude-code-webui:latest` (no separate tag/pipeline).
- **Resolved.** No mounted npx cache volume — MCP packages are fetched at first
  session spawn and cached in the clone's `config/npm-global` volume, which already
  persists across restarts (same pattern as the CRM sandbox).
