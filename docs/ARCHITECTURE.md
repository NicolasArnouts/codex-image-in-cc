# Architecture

## Overview

`codex-image-in-cc` is a dispatcher plus a file finisher. The user invokes a Claude Code slash command (`/codex-image:generate`, `/codex-image:edit`, `/codex-image:batch`, `/codex-image:status`) or the `codex-image` CLI; the SKILL.md runs `node scripts/codex-image.mjs <subcommand> "$ARGUMENTS"`; the Node script parses flags, spawns `codex exec --json`, reads the JSONL event stream, and then finalizes the files itself.

Design rule (0.4): **the wrapper owns files, Codex only makes pixels.** Codex's workspace-write sandbox only lets it write under `-C` and `--add-dir` dirs, and measured on codex-cli 0.172.0 about 44% of skill-mode runs failed to copy the result to the requested path (`Operation not permitted`), leaving it only in `$CODEX_HOME/generated_images/<thread_id>/`. So by default Codex is told to call `image_gen.imagegen` and nothing else, and the wrapper copies, converts, resizes and reports. The script stays stdlib-only Node.

## Repository layout

```
codex-image-in-cc/
├── .claude-plugin/              # plugin.json, marketplace.json
├── skills/                      # user-invoked Claude Code plugin skills
│   ├── generate/SKILL.md        # 1-line: node script generate "$ARGUMENTS"
│   ├── edit/SKILL.md
│   ├── batch/SKILL.md
│   └── status/SKILL.md
├── scripts/codex-image.mjs      # CLI: status, generate, edit, batch
├── tests/
│   ├── codex-image.test.mjs     # pure-function + hermetic end-to-end tests
│   └── fixtures/                # real codex JSONL (direct-low, skill-medium), fake-codex.mjs
├── docs/ARCHITECTURE.md         # this file
└── package.json                 # includes "bin": { "codex-image": ... }
```

## Call flow

1. Parse leading flags (`parseLeadingFlags`, using `splitFirstToken`): `--out --size --transparent --ref --mode --effort --model --force`, `--` terminator, `--flag=value` forms. Unknown `--xyz` starts the prompt.
2. Resolve settings: model = flag > `CODEX_IMAGE_MODEL` > none (no `-m`); effort = flag > `CODEX_IMAGE_EFFORT` > mode default (direct low, skill medium; `minimal`/`none` rejected, they hard-400); mode = flag > `CODEX_IMAGE_MODE` > direct.
3. Resolve `CODEX_HOME`: `CODEX_IMAGE_HOME` > `~/.codex-image` (if it exists) > inherited `CODEX_HOME` > `~/.codex`. It is passed to the child as `CODEX_HOME`; all `generated_images` lookups use it.
4. Plan the output (`resolveOutTarget`): `--out` ending in an image extension is a file, anything else a directory, default `<cwd>/codex-images/`. Existing files are never overwritten (`-v2`, `-v3`) unless `--force`.
5. Build the instruction (pure builders) and spawn:

```
codex exec --json --sandbox workspace-write -c approval_policy="never" --skip-git-repo-check \
  -c model_reasoning_effort="<e>" [-m <model>] [--image <abs>]... -C <cwd> --add-dir <out dir> \
  -o <tmp last-message file> -- <instruction>
```

   stdin is `ignore`. In skill mode, absolute image paths found in the prompt add `--add-dir` for their nearest existing ancestor.
6. Parse stdout JSONL line by line (non-JSON ignored): `thread.started` (thread id), `item.completed` `agent_message` (progress), `item.completed` `error` (non-fatal warning, deduped), `turn.completed` (usage), `turn.failed` / `error` (failure). Progress goes to stderr; child stderr is drained and only its last 4000 chars are kept (printed on failure). A hard timeout (`CODEX_IMAGE_TIMEOUT_MS`, default 540000) sends SIGTERM, then SIGKILL after 5 s.
7. Finalize (after the child exits): generated files = images in `<home>/generated_images/<thread_id>/` by mtime (without a thread id: files newer than the spawn). Skill mode first trusts files Codex saved itself (the out file, or `SAVED:` lines, modified after spawn) and otherwise falls back to the generated files. Direct mode copies to the planned destinations (png to jpg/jpeg via `sips -s format jpeg`, else warn and keep png; webp is not writable by sips and is rejected), then `--size` (cover + center-crop via `sips`), then reads dimensions and alpha via `sips -g`.
8. Print the stdout contract: `SAVED:`, `INFO:`, `USAGE:`. Exit 0 if at least one image was saved (a non-zero codex exit with images still saves them, with a warning), else 1.

`batch` validates the whole manifest first, then runs one turn per item through the same `runImageJob` path with a worker pool (`--parallel` 1-3). Finalization is synchronous, so destination planning cannot race between items in one process.

`status` runs `codex --version`, `codex login status` (with the resolved image home), `codex exec --sandbox workspace-write --help`, and `codex exec --help` (for `--image` and `--json`), and reports the home, whether the imagegen skill exists under it, the defaults and `sips` availability. `--json` prints the same as JSON.

## Load-bearing edge cases

Contracts the plugin depends on. Each lives in `scripts/codex-image.mjs`; keep them aligned with this section in the same PR.

### SKILL.md bash is NOT executed verbatim

When a slash command runs, Claude Code passes the SKILL.md template (with `$ARGUMENTS` substituted) to the model, and the model decides what bash to actually run. Empirically the model pre-evaluates `$(...)` substitutions, may treat literal `$1` / `$N` in single-quoted strings as positionals, and sometimes rewrites `==` to `=`. So **SKILL.md bash must not contain in-bash parsing logic**: keep it to a single-line invocation of the Node script and do all parsing in Node. This is why the flag grammar lives in the script and the SKILL.md files only document it.

### stdin trap

`codex exec` must be invoked with stdin ignored (`stdio: ["ignore","pipe","pipe"]`). Otherwise, in non-TTY contexts it treats piped stdin as an appendable `<stdin>` block and hangs waiting for EOF. This is not obvious from `codex exec --help`.

### Argument passing: argv vs a single string, and `--args-stdin`

Two input shapes reach the parser. A real shell argv (the `codex-image` CLI) has one element per shell word, so each element is exactly one token and only the elements after the flags are joined with spaces into the prompt; quoting done by the shell survives (`--out "/a b/x.png"`). A single string (slash-command text or `--args-stdin`) is split by the quote-aware tokenizer (`splitFirstToken`: single or double quotes, `\"` and `\'` unescaped inside quotes, `--flag="a b"` inline values); the remainder after the flags stays raw text. A lone argv element that is an existing file is taken as the `batch` manifest path unchanged.

Double quotes around `"$ARGUMENTS"` do NOT make the text safe: bash still expands `$`, backticks and `$(...)` inside double quotes, and a `"` inside the substituted text ends the quoted string early. The SKILL.md files therefore pass the arguments through a quoted heredoc (`<<'CODEX_IMAGE_ARGS'`, no expansion at all) to `--args-stdin`, which reads the raw string from the wrapper's own stdin. codex's stdin stays ignored.

### Sandbox mode, not `--full-auto` — and an explicit approval override

The wrapper passes `--sandbox workspace-write -c approval_policy="never"`. Headless `codex exec` resolves that to `approval: never` with `[workdir, /tmp, $TMPDIR]` writable — everything the `imagegen` flow needs to run `mkdir` / `cp` / `sips`, copy the selected output out of `~/.codex/generated_images/...`, and resize the final artifact.

Earlier versions of this plugin passed `--full-auto`, which resolved to the same workspace-write sandbox. Codex CLI 0.144.5 deprecated that spelling (`warning: --full-auto is deprecated; use --sandbox workspace-write instead`) and 0.151.0 removed it from `codex exec` outright (`error: unexpected argument '--full-auto' found`, exit 2), which broke every dispatch and the `status` probe with it ([#5](https://github.com/KingGyuSuh/codex-image-in-cc/issues/5)). `--sandbox workspace-write` is accepted by every release this plugin supports (verified live on 0.144.5 and 0.154.0 here, and on 0.151.0 in #5), so the wrapper uses it unconditionally — there is no per-process flag probe to keep in sync, and `status`, `generate`, and `edit` share one `CODEX_EXEC_BASE_ARGS` constant so the diagnostic can never disagree with what is dispatched.

The explicit `-c approval_policy="never"` is load-bearing, not decoration. `codex exec` defaults headless runs to approval-never via a harness override, but `build_exec_config` (codex-rs `exec/src/lib.rs`) drops that override — rebuilding with `approval_policy: None` — when the resolved config sets `approvals_reviewer = "auto_review"`, unless the legacy `--full-auto` / bypass flag set `preserve_headless_approval_policy`. Bare `--sandbox workspace-write` does not set that flag. Verified on 0.144.5 and again on 0.154.0 with an isolated config (`--ignore-user-config`): bare `--sandbox workspace-write` + `approvals_reviewer = "auto_review"` flips the session header to `approval: on-request` (which would route imagegen's shell steps through the reviewer), and adding `-c approval_policy="never"` restores `approval: never`. For configs without auto_review the override is a no-op — the resolved policy is `never` either way.

`--approve-for-me` (added in Codex CLI 0.153) is not a substitute. It selects the same workspace-write sandbox but resolves to `approval: on-request` behind the automatic reviewer (verified on 0.154.0), so imagegen's shell steps would go through a reviewer model turn instead of simply running inside the sandbox — different semantics and more tokens per turn. Do not use the undocumented `--yolo`, and do not reach for `--dangerously-bypass-approvals-and-sandbox` — image generation only ever needs to write inside the workspace.

The `status` `--image` check runs its own plain `codex exec --help` rather than reusing the headless probe's output. A rejected flag makes clap print a short usage error with no option list, which used to report `--image` as missing whenever the headless probe failed and sent users to an irrelevant "upgrade Codex CLI" next step.

### Git repository is optional

The Node script passes `--skip-git-repo-check` to `codex exec` because image generation should work in asset folders and scratch workspaces, not only git repositories.

### Edit input path parsing

`/codex-image:edit` splits `$ARGUMENTS` via a regex in `scripts/codex-image.mjs`'s `splitFirstToken`:

- Quoted first token (`"my photo.png" tint blue` or `'a b.png' brighten`) — quotes stripped, path may contain spaces.
- Unquoted first token (`photo.png make it red`) — first whitespace-separated word.

The Node check `fs.existsSync(inputPath)` rejects bad paths early with a clear message before spawning `codex`.

### File reservation and trust

Before spawning, every job reserves a concrete unique primary file name by creating an empty placeholder with `O_EXCL` (`reserveFile`, next `-vN` on EEXIST), so parallel batch items can never target the same file; further images of one job reserve `-<n>` names the same way. Finals are staged in a temp file in the destination dir (convert, `--size`), then renamed onto the placeholder; nothing is ever `copyFileSync`-ed over a file the job did not reserve (except with `--force`). A job that ends with no image removes its empty placeholders and any directories it created. Skill mode is told the exact reserved name and "never overwrite"; it only trusts a result (out file or `SAVED:` line) that has an image extension, lies inside the out dir, is non-empty, is newer than the spawn, is unclaimed by another item, and either did not exist in the pre-spawn dir snapshot or is the reserved placeholder. The INFO `source=` is matched by content hash and omitted when unknown. Without a thread id only a single unclaimed thread dir created after the spawn is used, and never while another job is running.

### Direct mode vs skill mode

Direct mode (default) tells Codex: call `image_gen.imagegen` with the request unchanged, do not read skill files, run shell commands or copy anything, and reply `DONE`. It avoids loading the imagegen skill (large token cost) and avoids every sandbox write failure, because Codex never writes the destination. Skill mode keeps the upstream `Use the imagegen skill...` prompt with a "save to <path>, print `SAVED: <path>`" paragraph and exists for cases where the skill's own prompt handling is wanted. Either way the wrapper verifies what exists on disk instead of trusting the model's report.

The built-in tool takes `prompt`, `transparent_background`, `referenced_image_paths` (max 5), `num_last_images_to_include` and `gif`, and has no size parameter (it returns for example 1254x1254), so `--size` is applied by the wrapper and the instruction only asks Codex to compose for the W:H aspect ratio.

### Reference and edit images

`--image` attaches files for model visibility; since Codex CLI 0.144 the tool's image inputs are local absolute paths passed as `referenced_image_paths` (max 5, also for edit targets), so the instructions list each absolute path. References are not edit targets and must not be modified.

### Model and effort are never hard-coded

An earlier version kept a ladder of model slugs probed against `codex debug models`; the slugs rotted (the ladder picked a legacy model). Now `-m` is only passed when the user asks (`--model` / `CODEX_IMAGE_MODEL`); otherwise Codex uses the account default. Reasoning effort is always passed (`-c model_reasoning_effort="<e>"`), defaulting to low in direct mode.

### Windows codex spawning

On Windows, npm installs `codex` as a `codex.cmd` shim. `spawn("codex", ...)` does not find it (`ENOENT`), and Node 20+ refuses to spawn `.cmd` files directly without `shell: true` (`EINVAL`, post-[CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2) hardening). `shell: true` is not an acceptable fix because user prompts contain quotes, ampersands, and non-ASCII text that cmd.exe would re-parse. The wrapper instead resolves the shim via `where.exe codex.cmd`, locates the real entry point at `<shim-dir>/node_modules/@openai/codex/bin/codex.js`, and spawns it with `process.execPath` (node.exe). If resolution fails it falls back to `codex.cmd`. macOS/Linux behavior is unchanged.

### Token accounting

Agent tokens count against the user's Codex usage limits. Measured on 0.172.0: direct mode at low about 37k input tokens (24k cached) per image; skill mode at medium about 85k; the old skill path at high about 138k. `USAGE:` reports the real numbers from `turn.completed`. Do not hide this from users.

## Tests

`npm test` runs `node --test`. Pure-function tests cover flag parsing, out-path planning, codex args, the JSONL parser (real fixtures in `tests/fixtures/`), skill-mode `--add-dir` scanning, batch validation and home resolution. Hermetic end-to-end tests run the CLI against `tests/fixtures/fake-codex.mjs` (via `CODEX_IMAGE_CODEX_BIN` and a temp `CODEX_IMAGE_HOME`): it prints JSONL, writes a real small PNG into `generated_images/<thread>/` and the `-o` file. No test calls the real codex or the network.

## Maintenance discipline

- **Wrapper owns files.** Do not let Codex write the destination in the default path.
- **No in-bash parsing in SKILL.md.** Single-line `node script <cmd> "$ARGUMENTS"` only.
- **Contract changes propagate here first.** If Codex CLI changes the headless contract (stdin ignored, `--json` event shapes, `--sandbox workspace-write -c approval_policy="never"`, `--skip-git-repo-check`, `--image`, `--add-dir`, `-o`, `-c model_reasoning_effort`, the `image_gen.imagegen` tool inputs, `<home>/generated_images/<thread_id>/`), update this document and the tests in the same change. Refresh the JSONL fixtures from a real run when event shapes change.
- **Scope is image generation.** A new Codex built-in tool deserves a separate plugin.

## Relationship to openai/codex-plugin-cc

Orthogonal and complementary.

| Plugin | Namespace | Scope |
|---|---|---|
| `openai/codex-plugin-cc` | `/codex:` | Code review, task delegation, background job lifecycle |
| `codex-image-in-cc` (this repo) | `/codex-image:` | Image generation via built-in `image_gen` |

There is no code dependency between the two. Users typically install both. If upstream decides to absorb image generation into the official plugin, this repo can be frozen or deprecated, but until then the independent release cadence is a feature, not a redundancy.
