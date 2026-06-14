# steve WebUI Clone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a second Claude Code WebUI instance ("steve") that reuses the existing `claude-code-webui:latest` image but runs in full isolation with a different default workspace (`/home/smooth/github/steve_project`), this machine's global Claude plugins + skills, a dev MCP tool set (github / playwright / firecrawl / context7) instead of the CRM bridges, and an always-empty workspace `CLAUDE.md`.

**Architecture:** One env-gated code change (`WEBUI_DISABLE_PROJECT_CLAUDE_MD`, default off) ships in the shared image; everything else is deployment config. A committed, idempotent seed script (`scripts/seed-steve-clone.sh`) scaffolds a separate runtime directory (`~/github/steve-webui/`) with its own `docker-compose.yml`, `.env`, `data/`, and a pre-populated `config/claude/` (skills + plugins copied from `~/.claude`, plus a curated `settings.json` that lists the four MCP servers). The clone container runs the same image with its own port (4546), volumes, and DB, so the two instances share nothing.

**Tech Stack:** Docker Compose, bash, python3 (JSON munging), rsync, Node/TypeScript (Express backend, zod config), the Claude Code CLI.

---

## Source-of-truth facts (verified during planning)

These were confirmed against the live codebase and this machine's `~/.claude`. They are the assumptions every task below relies on:

- The WebUI launches Claude with `--mcp-config <configHome>/settings.json` and **does not auto-load plugin MCP servers** — see the comment at `packages/backend/src/services/claude/ClaudeProcessManager.ts:2189-2193`. Therefore every MCP we want active must be listed explicitly in the seeded `settings.json` `mcpServers` block. (Enabled plugins still contribute their skills/commands.)
- The spawned CLI inherits the full container env: `cpSpawn(..., { env: { ...process.env, ...extraEnv, ... } })` at `ClaudeProcessManager.ts:2248`. So `FIRECRAWL_API_KEY` / `CONTEXT7_API_KEY` set in compose reach stdio MCP children with no per-server `env` block; the github **HTTP** MCP expands `${GITHUB_PERSONAL_ACCESS_TOKEN}` from that same env.
- Plugin MCP definitions on this host: `github` = HTTP `https://api.githubcopilot.com/mcp/` with header `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`; `playwright` = `npx -y @playwright/mcp@latest`; `context7` = `npx -y @upstash/context7-mcp`. The `firecrawl` plugin is **skills-only** (no `.mcp.json`) — real Firecrawl tools come from the OAuth-bound claude.ai connector, so the clone registers the standalone `firecrawl-mcp` npm package instead. The `codex` plugin has **no** MCP (command plugin only).
- `~/.claude/plugins/installed_plugins.json` and `known_marketplaces.json` embed absolute host paths (`/home/smooth/.claude/plugins/...`, `installLocation: /home/smooth/.claude/plugins/marketplaces/...`). These must be rewritten to `/home/node/.claude/...` for the container, whose config home is `/home/node/.claude`.
- `~/.claude/skills` contains symlinks pointing **outward** to `~/.agents/skills/<name>` (real dirs) — no loop back into `~/.claude`, so `rsync -aL` (dereference) is safe.
- Host `smooth` is uid 1000; the image's `node` user is uid 1000 → seeded files are readable in the container with **no chown** (uid match; perms are world-readable as a backstop).
- **Real CRM deployment identity (verified live):** the running CRM instance is the container **`crm-sandbox`** (image `crm-sandbox:latest`, ~2.81 GB) bound to `127.0.0.1:3001` — it is a separately-tagged build of this same Dockerfile (via the gitignored `docker-compose.override.yml`). There is **no** `claude-code-webui` container, and **no** `claude-code-webui:latest` image, until Task 4 builds one. The clone builds and runs `claude-code-webui:latest` (the same Dockerfile **plus** the new flag); `crm-sandbox` is a different image and is **never touched** by building or running the clone. (The flag is default-off, so even if `crm-sandbox` is later rebuilt from this source it is unaffected.)
- The backend has **no unit-test framework** (only `tsx` + `scripts/provider-regression-tests.ts`). The one code change is verified with a `tsx` assertion + `pnpm typecheck`, matching repo convention.

---

## File Structure

**Committed to the CRM repo (`/home/smooth/github/plum-code-webui`):**

| File | Responsibility | Change |
| --- | --- | --- |
| `packages/backend/src/config.ts` | Parse `WEBUI_DISABLE_PROJECT_CLAUDE_MD` → `config.disableProjectClaudeMd` | Modify |
| `packages/backend/src/services/claude/ClaudeProcessManager.ts` | Skip the workspace project-context write when the flag is set | Modify (≈line 1877) |
| `docker-compose.yml` | Pass the new env vars through (empty defaults ⇒ CRM unaffected) | Modify |
| `.env.example` | Document the new env vars | Modify |
| `scripts/seed-steve-clone.sh` | Idempotent scaffolder for the clone runtime dir | Create |

**Created at runtime in `~/github/steve-webui/` (NOT committed — deployment instance, lives outside the repo):**

| File | Responsibility |
| --- | --- |
| `docker-compose.yml` | Clone service: image-only (no build), port 4546, isolated volumes |
| `.env` | Per-instance secrets + MCP key placeholders (gitignored by location, `chmod 600`) |
| `config/claude/skills/` | Dereferenced copy of `~/.claude/skills` |
| `config/claude/plugins/` | Copy of `~/.claude/plugins` with host paths rewritten |
| `config/claude/settings.json` | `enabledPlugins` + `extraKnownMarketplaces` + the four `mcpServers` |
| `config/{codex,opencode,vibe,npm-global}/`, `data/` | Empty isolated state dirs |

**Also created:** `~/github/steve_project/` (the clone's workspace; left empty — no `CLAUDE.md`).

---

## Task 1: Add the `WEBUI_DISABLE_PROJECT_CLAUDE_MD` config flag

**Files:**
- Modify: `packages/backend/src/config.ts` (zod schema ~line 45; returned object ~line 88)

- [ ] **Step 1: Write the failing assertion**

Create a throwaway checker (not committed) at `/tmp/check-flag.ts`:

```ts
// Asserts the flag round-trips through the real config module.
process.env.SESSION_SECRET ||= 'x'.repeat(48);
process.env.JWT_SECRET ||= 'y'.repeat(48);
process.env.WEBUI_DISABLE_PROJECT_CLAUDE_MD = '1';
const { config } = await import('/home/smooth/github/plum-code-webui/packages/backend/src/config.ts');
if ((config as any).disableProjectClaudeMd !== true) {
  console.error('FAIL: disableProjectClaudeMd =', (config as any).disableProjectClaudeMd);
  process.exit(1);
}
console.log('PASS: disableProjectClaudeMd = true');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/smooth/github/plum-code-webui/packages/backend && npx tsx /tmp/check-flag.ts`
Expected: `FAIL: disableProjectClaudeMd = undefined` (exit 1)

- [ ] **Step 3: Add the env var to the zod schema**

In `packages/backend/src/config.ts`, inside `envSchema = z.object({ ... })`, immediately after the `AUTH_ALLOWED_EMAILS` field (the last field, ~line 45):

```ts
  AUTH_ALLOWED_EMAILS: z.string().optional(),
  // When set to "1"/"true", skip writing the auto-generated project-context
  // block into <workingDir>/CLAUDE.md. Used by the "steve" clone so its
  // workspace CLAUDE.md stays empty. Default off ⇒ the CRM sandbox is unaffected.
  WEBUI_DISABLE_PROJECT_CLAUDE_MD: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});
```

(Replace the existing `  AUTH_ALLOWED_EMAILS: z.string().optional(),\n});` closing with the block above.)

- [ ] **Step 4: Expose it on the returned config object**

In the `return { ... }` of `loadConfig()`, add a top-level property after `previewHostname: env.PREVIEW_HOSTNAME?.toLowerCase(),`:

```ts
    previewHostname: env.PREVIEW_HOSTNAME?.toLowerCase(),
    // True ⇒ ClaudeProcessManager skips the per-project CLAUDE.md write.
    disableProjectClaudeMd: env.WEBUI_DISABLE_PROJECT_CLAUDE_MD,
```

- [ ] **Step 5: Run the assertion (green) + the off-default case + typecheck**

Run: `cd /home/smooth/github/plum-code-webui/packages/backend && npx tsx /tmp/check-flag.ts`
Expected: `PASS: disableProjectClaudeMd = true`

Run the default-off case:
```bash
cd /home/smooth/github/plum-code-webui/packages/backend && \
SESSION_SECRET=$(printf 'a%.0s' {1..48}) JWT_SECRET=$(printf 'b%.0s' {1..48}) \
npx tsx -e "import('./src/config.ts').then(m=>{const v=m.config.disableProjectClaudeMd; if(v!==false){console.error('FAIL default not false:',v);process.exit(1)} console.log('PASS default false')})"
```
Expected: `PASS default false`

Run: `pnpm --filter @claude-code-webui/backend run typecheck`
Expected: no errors

Then remove the throwaway: `rm -f /tmp/check-flag.ts`

- [ ] **Step 6: Commit**

```bash
cd /home/smooth/github/plum-code-webui
git add packages/backend/src/config.ts
git commit -m "feat(config): add WEBUI_DISABLE_PROJECT_CLAUDE_MD flag (default off)"
```

---

## Task 2: Gate the workspace `CLAUDE.md` write behind the flag

**Files:**
- Modify: `packages/backend/src/services/claude/ClaudeProcessManager.ts:1877`

- [ ] **Step 1: Wrap the `ensureProjectInstructions` call**

In `ClaudeProcessManager.ts`, the block is currently:

```ts
    // Write skills/agents to global ~/.claude/CLAUDE.md + lightweight project context
    await ensureGlobalInstructions(configHome);
    await ensureProjectInstructions(session.working_directory, configHome, cliProvider);
    syncProviderLinks({ quiet: true });
```

Replace the middle line so the per-project write is skipped when the flag is set (the global registry write stays untouched):

```ts
    // Write skills/agents to global ~/.claude/CLAUDE.md + lightweight project context
    await ensureGlobalInstructions(configHome);
    // The "steve" clone sets WEBUI_DISABLE_PROJECT_CLAUDE_MD=1 so its workspace
    // CLAUDE.md stays empty. Default off ⇒ the CRM sandbox writes it as before.
    if (!config.disableProjectClaudeMd) {
      await ensureProjectInstructions(session.working_directory, configHome, cliProvider);
    }
    syncProviderLinks({ quiet: true });
```

(`config` is already imported at `ClaudeProcessManager.ts:20`.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @claude-code-webui/backend run typecheck`
Expected: no errors

- [ ] **Step 3: Grep-verify the wiring**

Run: `grep -n "disableProjectClaudeMd" packages/backend/src/services/claude/ClaudeProcessManager.ts`
Expected: one match showing the `if (!config.disableProjectClaudeMd) {` guard around the `ensureProjectInstructions` call.

- [ ] **Step 4: Commit**

```bash
cd /home/smooth/github/plum-code-webui
git add packages/backend/src/services/claude/ClaudeProcessManager.ts
git commit -m "feat(claude): skip per-project CLAUDE.md write when WEBUI_DISABLE_PROJECT_CLAUDE_MD set"
```

---

## Task 3: Pass the new env vars through `docker-compose.yml` + document them

**Files:**
- Modify: `docker-compose.yml` (under `environment:`)
- Modify: `.env.example`

- [ ] **Step 1: Add env passthroughs (empty defaults ⇒ CRM unaffected)**

In `docker-compose.yml`, the existing line is:

```yaml
      # Comma-separated provider ids to hide from the UI (codex,opencode,vibe,claude)
      - WEBUI_DISABLED_PROVIDERS=${WEBUI_DISABLED_PROVIDERS:-}
```

Insert immediately after it:

```yaml
      # Keep the auto-generated project-context block out of <workspace>/CLAUDE.md
      # (set to 1 by the "steve" clone). Empty ⇒ default behaviour.
      - WEBUI_DISABLE_PROJECT_CLAUDE_MD=${WEBUI_DISABLE_PROJECT_CLAUDE_MD:-}
      # Dev MCP credentials (used only when settings.json registers these servers)
      - GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN:-}
      - FIRECRAWL_API_KEY=${FIRECRAWL_API_KEY:-}
      - CONTEXT7_API_KEY=${CONTEXT7_API_KEY:-}
```

- [ ] **Step 2: Document in `.env.example`**

Append to `.env.example`:

```bash

# --- steve clone / dev MCP tooling (optional; unused by the CRM sandbox) ---
# Skip writing the auto project-context block into <workspace>/CLAUDE.md.
WEBUI_DISABLE_PROJECT_CLAUDE_MD=
# GitHub PAT (repo scope) for the github HTTP MCP server.
GITHUB_PERSONAL_ACCESS_TOKEN=
# Firecrawl API key for the firecrawl MCP server (https://firecrawl.dev).
FIRECRAWL_API_KEY=
# Optional: higher context7 rate limits (works blank).
CONTEXT7_API_KEY=
```

- [ ] **Step 3: Validate compose still parses**

Run: `cd /home/smooth/github/plum-code-webui && docker compose config >/dev/null && echo OK`
Expected: `OK` (no interpolation errors)

- [ ] **Step 4: Commit**

```bash
cd /home/smooth/github/plum-code-webui
git add docker-compose.yml .env.example
git commit -m "chore(compose): pass steve-clone env vars through (empty defaults)"
```

---

## Task 4: Build the clone's image (bakes in the §7 flag)

**Files:** none (build only).

> **Why this does not affect CRM:** the portable `docker-compose.yml` in this repo tags its build `claude-code-webui:latest`. The running CRM container `crm-sandbox` uses a **different** image (`crm-sandbox:latest`) built via the gitignored override. Building `claude-code-webui:latest` therefore creates a brand-new image the clone will use and leaves `crm-sandbox` (image + running container) completely untouched.

- [ ] **Step 1: Build the image**

Run: `cd /home/smooth/github/plum-code-webui && docker compose build`
Expected: builds `claude-code-webui:latest` successfully.

- [ ] **Step 2: Confirm the flag code is in the image**

Run:
```bash
docker run --rm --entrypoint sh claude-code-webui:latest -c \
  "grep -c disableProjectClaudeMd packages/backend/src/config.ts packages/backend/src/services/claude/ClaudeProcessManager.ts"
```
Expected: two non-zero counts (the flag is present in both files inside the image).

- [ ] **Step 3: Confirm the new image exists and CRM is untouched**

Run:
```bash
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E 'claude-code-webui:latest|crm-sandbox:latest'
docker ps --filter name=crm-sandbox --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
```
Expected: both image tags listed (they are distinct images); `crm-sandbox` still shows `Up ...` on `127.0.0.1:3001->3001/tcp` — building the clone image did not restart or alter it.

> No commit — this is a build artifact, not a source change.

---

## Task 5: Create the clone seed script

**Files:**
- Create: `scripts/seed-steve-clone.sh`

- [ ] **Step 1: Write the full seed script**

Create `scripts/seed-steve-clone.sh` with exactly this content:

```bash
#!/usr/bin/env bash
# scripts/seed-steve-clone.sh
#
# Scaffolds the "steve" WebUI clone — a second Claude Code WebUI instance that
# reuses the claude-code-webui:latest image but carries THIS machine's global
# Claude plugins + skills + a dev MCP tool set (github / playwright / firecrawl /
# context7) instead of the CRM bridges.
#
# Idempotent: re-running refreshes skills / plugins / settings / compose but
# NEVER clobbers an existing .env (so pasted secrets survive).
#
# Usage:  scripts/seed-steve-clone.sh [CLONE_DIR] [WORKSPACE_DIR]
# Defaults: CLONE_DIR=$HOME/github/steve-webui  WORKSPACE_DIR=$HOME/github/steve_project
set -euo pipefail

SRC_CLAUDE="${SRC_CLAUDE:-$HOME/.claude}"
CLONE_DIR="${1:-$HOME/github/steve-webui}"
WORKSPACE_DIR="${2:-$HOME/github/steve_project}"
CONTAINER_CONFIG_HOME="/home/node/.claude"
CFG="$CLONE_DIR/config/claude"

echo "==> steve clone seed"
echo "    source config : $SRC_CLAUDE"
echo "    clone dir     : $CLONE_DIR"
echo "    workspace     : $WORKSPACE_DIR"

# 1. Preconditions
command -v rsync   >/dev/null || { echo "ERROR: rsync required";   exit 1; }
command -v python3 >/dev/null || { echo "ERROR: python3 required"; exit 1; }
[ -d "$SRC_CLAUDE/skills" ]        || { echo "ERROR: $SRC_CLAUDE/skills missing";        exit 1; }
[ -d "$SRC_CLAUDE/plugins" ]       || { echo "ERROR: $SRC_CLAUDE/plugins missing";       exit 1; }
[ -f "$SRC_CLAUDE/settings.json" ] || { echo "ERROR: $SRC_CLAUDE/settings.json missing"; exit 1; }

# 2. Scaffold isolated state dirs
mkdir -p "$CFG" \
         "$CLONE_DIR/config/codex" \
         "$CLONE_DIR/config/opencode" \
         "$CLONE_DIR/config/vibe" \
         "$CLONE_DIR/config/npm-global" \
         "$CLONE_DIR/data" \
         "$WORKSPACE_DIR"

# rsync wrapper that tolerates symlink "vanished/partial" exit codes (23/24)
_rsync() {
  rsync "$@" || { rc=$?; [ "$rc" = 23 ] || [ "$rc" = 24 ] || { echo "rsync failed ($rc)"; exit "$rc"; }; }
}

# 3. Skills — dereference symlinks so real content lands (not dangling links)
echo "==> copying skills (deref)…"
_rsync -aL --delete "$SRC_CLAUDE/skills/" "$CFG/skills/"

# 4. Plugins — copy the loadable tree (marketplaces/, cache/, registries) but
#    EXCLUDE plugins/data/ — that's per-session runtime/job state (e.g. Codex
#    job history) that the plugin loader never reads, carries absolute host
#    paths, and is exactly the "history" spec §5 says NOT to clone.
echo "==> copying plugins (deref, excluding runtime data/)…"
_rsync -aL --delete --exclude 'data/' "$SRC_CLAUDE/plugins/" "$CFG/plugins/"

echo "==> rewriting host paths -> $CONTAINER_CONFIG_HOME in plugin registries…"
python3 - "$SRC_CLAUDE" "$CONTAINER_CONFIG_HOME" "$CFG" <<'PY'
import sys, pathlib
src, dst, cfg = sys.argv[1], sys.argv[2], sys.argv[3]
for name in ("plugins/installed_plugins.json", "plugins/known_marketplaces.json"):
    p = pathlib.Path(cfg) / name
    if not p.exists():
        continue
    text = p.read_text()
    # Rewrite only the config-home prefix (installPath / installLocation).
    # Project paths ($HOME/github/...) use a different prefix and are left as-is
    # (they are inert in the clone — its cwd never matches them).
    text = text.replace(src, dst)
    p.write_text(text)
    print(f"    rewrote {p}")
PY

# Fail-fast: after excluding data/ and rewriting the registries, NO config-home
# host path may remain anywhere in the loadable plugin tree. (projectPath entries
# like $HOME/github/... use a different prefix and are intentionally untouched.)
echo "==> verifying no residual config-home paths in plugins…"
LEAK="$(grep -rl "$SRC_CLAUDE" "$CFG/plugins" 2>/dev/null || true)"
if [ -n "$LEAK" ]; then
  echo "ERROR: residual host config-home paths ($SRC_CLAUDE) in copied plugins:"
  echo "$LEAK"
  exit 1
fi

# 5. Curated settings.json: host enabledPlugins + extraKnownMarketplaces + our MCP servers.
#    - stdio servers (playwright/context7/firecrawl) carry NO `env` block: their
#      child processes inherit the full container env (ClaudeProcessManager.ts:2248),
#      so FIRECRAWL_API_KEY / CONTEXT7_API_KEY reach them from compose. Inheritance
#      is more robust here than relying on ${VAR} expansion inside an env block.
#    - github is HTTP, so it has no child to inherit env; its bearer token uses
#      ${GITHUB_PERSONAL_ACCESS_TOKEN} header expansion (see Task 8 for the auth
#      check + fallback if your CLI build doesn't expand header vars).
#    - host `model`/`effortLevel` are deliberately OMITTED: the WebUI selects the
#      model via the CLI `--model` flag (getCliModelForUser), so a settings.json
#      `model` would be ignored at best and conflict at worst.
echo "==> writing curated settings.json…"
python3 - "$SRC_CLAUDE/settings.json" "$CFG/settings.json" <<'PY'
import sys, json
src, out = sys.argv[1], sys.argv[2]
host = json.load(open(src))
settings = {
    "enabledPlugins": host.get("enabledPlugins", {}),
    "extraKnownMarketplaces": host.get("extraKnownMarketplaces", {}),
    "mcpServers": {
        "github": {
            "type": "http",
            "url": "https://api.githubcopilot.com/mcp/",
            "headers": {"Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"},
        },
        "playwright": {"command": "npx", "args": ["-y", "@playwright/mcp@latest"]},
        "context7":   {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]},
        "firecrawl":  {"command": "npx", "args": ["-y", "firecrawl-mcp"]},
    },
}
json.dump(settings, open(out, "w"), indent=2)
print(f"    wrote {out} "
      f"({len(settings['enabledPlugins'])} plugins, {len(settings['mcpServers'])} MCP servers)")
PY

# 6. docker-compose.yml — image-only (no build). Quoted heredoc (no shell
#    expansion); $WORKSPACE_DIR is substituted afterward via sed so future $-vars
#    in the compose body can never expand by accident.
echo "==> writing docker-compose.yml…"
cat > "$CLONE_DIR/docker-compose.yml" <<'COMPOSE'
services:
  claude-code-webui-steve:
    image: claude-code-webui:latest
    container_name: claude-code-webui-steve
    restart: unless-stopped
    ports:
      - '4546:3001'
    shm_size: '1gb'
    extra_hosts:
      - 'host.docker.internal:host-gateway'
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - ALLOWED_BASE_PATHS=/workspace
      - CONTAINER_NAME=claude-code-webui-steve
      - WEBUI_DISABLE_PROJECT_CLAUDE_MD=1
      - FRONTEND_URL=http://localhost:4546
      - CORS_ALLOWED_ORIGINS=http://localhost:4546
      - PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/local/bin/plum-chromium
      - PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    volumes:
      - ./data:/app/packages/backend/data
      - ./config/claude:/home/node/.claude
      - ./config/codex:/home/node/.codex
      - ./config/opencode:/home/node/.opencode
      - ./config/vibe:/home/node/.vibe
      - ./config/npm-global:/home/node/.npm-global
      - __WORKSPACE_DIR__:/workspace
    healthcheck:
      test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3001/health']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
COMPOSE
sed -i "s#__WORKSPACE_DIR__#${WORKSPACE_DIR}#" "$CLONE_DIR/docker-compose.yml"

# 7. .env — generate once with fresh secrets; never clobber an existing one
if [ -f "$CLONE_DIR/.env" ]; then
  echo "==> .env exists — leaving it untouched"
else
  echo "==> generating .env (fresh secrets + key placeholders)…"
  SS="$(head -c48 /dev/urandom | base64 | tr -d '\n')"
  JJ="$(head -c48 /dev/urandom | base64 | tr -d '\n')"
  cat > "$CLONE_DIR/.env" <<ENV
# steve clone — generated $(date -u +%FT%TZ) by scripts/seed-steve-clone.sh
# Per-instance secrets; the GitHub/Firecrawl keys are blank — paste yours, then
# re-run \`docker compose up -d\` from this dir to load them.
SESSION_SECRET=$SS
JWT_SECRET=$JJ

# GitHub PAT (classic or fine-grained, repo scope) for the github HTTP MCP:
GITHUB_PERSONAL_ACCESS_TOKEN=

# Firecrawl API key for the firecrawl MCP (https://firecrawl.dev):
FIRECRAWL_API_KEY=

# Optional — higher context7 limits (works blank):
CONTEXT7_API_KEY=
ENV
  chmod 600 "$CLONE_DIR/.env"
fi

# 8. Runbook
cat <<DONE

==> steve clone seeded at: $CLONE_DIR

Next:
  1. Build the image once (from the CRM repo, so the flag is baked in):
       cd $HOME/github/plum-code-webui && docker compose build
  2. Start the clone:
       cd "$CLONE_DIR" && docker compose up -d
  3. Open http://localhost:4546 — set up basic-auth / log in.
  4. Run Claude /login inside the clone (fresh, separate from CRM).
  5. Settings -> set default working directory = /workspace
  6. Paste GITHUB_PERSONAL_ACCESS_TOKEN + FIRECRAWL_API_KEY into $CLONE_DIR/.env,
     then: cd "$CLONE_DIR" && docker compose up -d   # recreate to load keys
  7. Start a NEW Claude session; confirm github / playwright / firecrawl /
     context7 tools are present and that $WORKSPACE_DIR/CLAUDE.md stays empty.
DONE
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x /home/smooth/github/plum-code-webui/scripts/seed-steve-clone.sh`

- [ ] **Step 3: Syntax-check the script**

Run: `bash -n /home/smooth/github/plum-code-webui/scripts/seed-steve-clone.sh && echo "syntax OK"`
Expected: `syntax OK`

- [ ] **Step 4: Dry-run into a throwaway dir (verifies structure without touching the real clone)**

```bash
cd /home/smooth/github/plum-code-webui
rm -rf /tmp/steve-dryrun /tmp/steve-ws
./scripts/seed-steve-clone.sh /tmp/steve-dryrun /tmp/steve-ws
echo "--- settings.json mcpServers + plugin count ---"
python3 -c "import json;d=json.load(open('/tmp/steve-dryrun/config/claude/settings.json'));print('mcp:',list(d['mcpServers']));print('plugins:',len(d['enabledPlugins']))"
echo "--- path rewrite check: config-home host refs across the WHOLE plugin tree (must be 0) ---"
grep -rl "/home/$(id -un)/.claude" /tmp/steve-dryrun/config/claude/plugins | wc -l
echo "--- runtime data/ must be excluded (must be absent) ---"
test ! -d /tmp/steve-dryrun/config/claude/plugins/data && echo "plugins/data/ excluded (good)" || echo "WARN: plugins/data/ present"
echo "--- skills deref check (must be 0 symlinks) ---"
find /tmp/steve-dryrun/config/claude/skills -maxdepth 2 -type l | wc -l
echo "--- compose validity ---"
( cd /tmp/steve-dryrun && docker compose config >/dev/null && echo "compose OK" )
echo "--- workspace has NO CLAUDE.md ---"
test ! -e /tmp/steve-ws/CLAUDE.md && echo "no CLAUDE.md (good)"
```

Expected:
- `mcp: ['github', 'playwright', 'context7', 'firecrawl']`
- `plugins:` a positive integer (≈17)
- config-home host-ref count: `0`
- `plugins/data/ excluded (good)`
- symlink count: `0`
- `compose OK`
- `no CLAUDE.md (good)`

- [ ] **Step 5: Clean up the dry-run**

Run: `rm -rf /tmp/steve-dryrun /tmp/steve-ws`

- [ ] **Step 6: Commit**

```bash
cd /home/smooth/github/plum-code-webui
git add scripts/seed-steve-clone.sh
git commit -m "feat(scripts): add seed-steve-clone.sh to scaffold the steve WebUI clone"
```

---

## Task 6: Seed the real clone directory

**Files:** creates `~/github/steve-webui/**` and `~/github/steve_project/` (outside the repo).

- [ ] **Step 1: Run the seed for real**

Run: `cd /home/smooth/github/plum-code-webui && ./scripts/seed-steve-clone.sh`
Expected: ends with the "steve clone seeded at: /home/smooth/github/steve-webui" runbook.

- [ ] **Step 2: Verify the seeded layout**

```bash
ls -la ~/github/steve-webui
echo "--- settings.json ---"
python3 -c "import json;d=json.load(open('/home/smooth/github/steve-webui/config/claude/settings.json'));print('mcp:',list(d['mcpServers']));print('plugins:',len(d['enabledPlugins']),'marketplaces:',len(d['extraKnownMarketplaces']))"
echo "--- no config-home host paths anywhere in the plugin tree (must be 0) ---"
grep -rl "/home/smooth/.claude" ~/github/steve-webui/config/claude/plugins | wc -l
test ! -d ~/github/steve-webui/config/claude/plugins/data && echo "plugins/data/ excluded (good)"
echo "--- .env has secrets, blank keys ---"
grep -E '^(SESSION_SECRET|JWT_SECRET)=.+' ~/github/steve-webui/.env | sed 's/=.*/=<set>/'
grep -E '^(GITHUB_PERSONAL_ACCESS_TOKEN|FIRECRAWL_API_KEY)=$' ~/github/steve-webui/.env
echo "--- workspace empty, no CLAUDE.md ---"
ls -la ~/github/steve_project; test ! -e ~/github/steve_project/CLAUDE.md && echo "no CLAUDE.md (good)"
```

Expected: `mcp:` lists the four servers; the config-home host-ref count is `0` and `plugins/data/ excluded (good)`; `SESSION_SECRET=<set>` / `JWT_SECRET=<set>`; the two key lines print blank (`=`); workspace has no `CLAUDE.md`.

> No commit — these files live outside the repo.

---

## Task 7: Boot the clone and verify isolation

**Files:** none (runtime).

- [ ] **Step 1: Start the clone**

Run: `cd ~/github/steve-webui && docker compose up -d`
Expected: container `claude-code-webui-steve` created and starting.

- [ ] **Step 2: Wait for health + verify the endpoint**

```bash
cd ~/github/steve-webui
for i in $(seq 1 20); do
  s=$(docker inspect -f '{{.State.Health.Status}}' claude-code-webui-steve 2>/dev/null || echo none)
  echo "health: $s"; [ "$s" = healthy ] && break; sleep 5
done
curl -sf http://localhost:4546/health && echo " <- /health OK"
```
Expected: `health: healthy` then `... <- /health OK`.

- [ ] **Step 3: Verify isolation from the running CRM container**

```bash
docker ps --filter name=claude-code-webui-steve --filter name=crm-sandbox \
  --format '{{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
```
Expected: two distinct containers — `crm-sandbox` (image `crm-sandbox`) still `Up` on `127.0.0.1:3001`, and `claude-code-webui-steve` (image `claude-code-webui:latest`) `Up` on `0.0.0.0:4546->3001`. Different names, images, ports, and (per the seed) different config/data/workspace volumes ⇒ no overlap.

- [ ] **Step 4: Verify the flag + seeded config are live inside the container**

```bash
docker exec claude-code-webui-steve printenv WEBUI_DISABLE_PROJECT_CLAUDE_MD
docker exec claude-code-webui-steve sh -c 'python3 -c "import json;d=json.load(open(\"/home/node/.claude/settings.json\"));print(list(d[\"mcpServers\"]))" 2>/dev/null || node -e "console.log(Object.keys(require(\"/home/node/.claude/settings.json\").mcpServers))"'
docker exec claude-code-webui-steve sh -c 'ls /home/node/.claude/plugins/marketplaces && ls /home/node/.claude/skills | head'
```
Expected: prints `1`; the four MCP server names; the marketplace dirs and some skill names (proving the bind mount + seed are visible to the container).

> No commit.

---

## Task 8: End-to-end acceptance (manual, in the browser)

This is the real acceptance test for the workspace-`CLAUDE.md` and MCP requirements; it needs a logged-in session, so it is driven through the UI.

- [ ] **Step 1: First-boot setup**

In a browser:
1. Open `http://localhost:4546`; configure basic-auth (or log in).
2. Run Claude `/login` in the clone (its config volume is fresh — separate from CRM).
3. Settings → set the default working directory to `/workspace`.

- [ ] **Step 2: Wire the MCP keys**

Paste the GitHub PAT and Firecrawl key into `~/github/steve-webui/.env`, then:

Run: `cd ~/github/steve-webui && docker compose up -d`
Expected: container recreated with the keys in its environment.

- [ ] **Step 3: Verify MCP tools + empty CLAUDE.md in a live session**

Start a **new** Claude session in the clone (lands in `/workspace`) and ask it to list its available MCP tools. Then on the host:

```bash
test ! -s /home/smooth/github/steve_project/CLAUDE.md && echo "CLAUDE.md empty/absent (good)" || { echo "UNEXPECTED CLAUDE.md:"; cat /home/smooth/github/steve_project/CLAUDE.md; }
```

Expected:
- The session reports `github`, `playwright`, `firecrawl`, and `context7` tools available (e.g. `mcp__github__*`, `mcp__playwright__*`, `mcp__firecrawl__*`, `mcp__context7__*`).
- `CLAUDE.md empty/absent (good)` — the workspace `CLAUDE.md` was not written.

> **First-spawn note:** `firecrawl-mcp`, `@playwright/mcp`, and `@upstash/context7-mcp` are fetched from npm on the first session spawn (cached afterward in the `config/npm-global` volume). The container must have outbound npm access on that first run.

> **github auth fallback (the one unverified mechanism):** the `github` HTTP server authenticates via `Authorization: Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}`, which relies on the Claude CLI expanding `${VAR}` inside an mcp-config **header**. This is the documented Claude Code behavior and matches the host's own `.mcp.json`. If — and only if — the `github` tools fail to authenticate while playwright/firecrawl/context7 work, the token is not being expanded; fix by writing the literal token into the clone's settings.json header and recreating:
> ```bash
> python3 - <<'PY'
> import json, os, pathlib
> p = pathlib.Path(os.path.expanduser("~/github/steve-webui/config/claude/settings.json"))
> d = json.load(open(p))
> tok = os.environ["GITHUB_PERSONAL_ACCESS_TOKEN"]  # export it first, or paste inline
> d["mcpServers"]["github"]["headers"]["Authorization"] = f"Bearer {tok}"
> json.dump(d, open(p, "w"), indent=2)
> print("baked literal github token into settings.json")
> PY
> cd ~/github/steve-webui && docker compose up -d
> ```
> (Note: re-running `seed-steve-clone.sh` would revert this to the `${VAR}` placeholder — re-apply the literal if you ever re-seed.)

- [ ] **Step 4: Confirm the CRM sandbox (`crm-sandbox`) is unaffected**

The clone runs a different image (`claude-code-webui:latest`) and never touches `crm-sandbox`. Confirm the running CRM has no flag set (so it writes `CLAUDE.md` exactly as before):

Run: `docker exec crm-sandbox printenv WEBUI_DISABLE_PROJECT_CLAUDE_MD || echo "(unset — CRM writes CLAUDE.md as before)"`
Expected: `(unset — CRM writes CLAUDE.md as before)` — the flag is absent on `crm-sandbox`, so its behavior is identical to before this work.

> No commit — runtime verification only.

---

## Self-Review

**1. Spec coverage**

| Spec section | Covered by |
| --- | --- |
| §1 Container / isolation | Task 5 (compose), Task 6 (seed), Task 7 (boot + isolation checks) |
| §2 Default directory (`ALLOWED_BASE_PATHS=/workspace`, workspace mount, set default dir) | Task 5 (compose env + volume), Task 8 step 1.3 |
| §3 Plugins + skills parity (deref skills, copy plugins, curated settings.json) | Task 5 (script), Task 6 (verify) |
| §4 MCP servers (4 servers, keys wired, exclusions) | Task 5 settings.json block, Task 3 env, Task 8 step 2–3 |
| §5 Secrets / hygiene (copy only skills+plugins+settings; never credentials/history/etc.) | Task 5 copies exactly `skills/`, `plugins/`, `settings.json` — nothing else |
| §6 CLAUDE.md handling (empty workspace file) | Task 1–2 (flag), Task 8 step 3 |
| §7 The one code change | Task 1, Task 2, Task 4 (bake into image) |
| §8 One-time setup | Task 8 |

No spec requirement is left without a task.

**2. Placeholder scan:** No "TBD/TODO/implement later". Every code/script/compose block is complete and concrete.

**3. Type / name consistency:** `WEBUI_DISABLE_PROJECT_CLAUDE_MD` (env) → `config.disableProjectClaudeMd` (boolean) is used identically in Task 1 (define) and Task 2 (consume). MCP server names (`github`, `playwright`, `context7`, `firecrawl`) match between the spec §4 table, the seed script, and the Task 8 verification. Paths (`~/github/steve-webui`, `~/github/steve_project`, `/home/node/.claude`, port `4546`) are consistent across all tasks.

**4. Hygiene guardrails honored:** the seed copies **only** `skills/`, `plugins/` (with `plugins/data/` runtime/job history **excluded**), and a freshly-built `settings.json` — it never reads `~/.claude/.credentials.json`, `history.jsonl`, `projects/`, `hooks`, `statusLine`, `permissions`, or the global `~/.claude/CLAUDE.md`. A fail-fast scan aborts the seed if any config-home host path survives in the copied plugin tree. The `.env` is created with `chmod 600`, lives outside the repo, and is never clobbered on re-run.

**5. Post-review fixes applied:** retargeted all container/image checks to the real `crm-sandbox` instance (there is no `claude-code-webui` container until Task 4 builds the image); excluded `plugins/data/` and added a fail-fast leak scan; widened the dry-run/seed path-rewrite verification to the whole plugin tree; switched the compose heredoc to quoted + `sed`; documented the `github` `${VAR}`-header auth check and a literal-token fallback; noted first-spawn npm reachability and the deliberate omission of `model`/`effortLevel`.
