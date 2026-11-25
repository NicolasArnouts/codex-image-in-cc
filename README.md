# codex-image-in-cc

[![Test](https://github.com/KingGyuSuh/codex-image-in-cc/actions/workflows/test.yml/badge.svg)](https://github.com/KingGyuSuh/codex-image-in-cc/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/KingGyuSuh/codex-image-in-cc.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](https://nodejs.org)

Claude Code plugin that generates and edits images through Codex CLI's built-in image generation tool, as `/codex-image:*` user-invoked plugin skills and as a `codex-image` command-line tool. This is the `0.4.0-nico.1` fork of [KingGyuSuh/codex-image-in-cc](https://github.com/KingGyuSuh/codex-image-in-cc).

The plugin does not implement image generation itself. The wrapper runs `codex exec --json --sandbox workspace-write`, lets Codex call the built-in `image_gen` tool, and then handles the files itself: it copies the result to your `--out` path, applies `--size`, and prints `SAVED:` / `INFO:` / `USAGE:` lines. Codex only makes pixels.

## Requirements

- Claude Code with plugin support.
- `@openai/codex` CLI v0.142.0 or later (v0.144+ recommended — it moves image generation to the extension-backed tool the instruction prefixes are written for). The wrapper dispatches with `--sandbox workspace-write` and `--json` (0.151+ removed `--full-auto`).
- An active `codex login` session.
- Node.js 18.18 or later.

`OPENAI_API_KEY` is not required for the default built-in path. Codex can use either a ChatGPT login or API-key login.

## Install

### From GitHub (recommended)

```bash
claude plugin marketplace add KingGyuSuh/codex-image-in-cc
claude plugin install codex-image@codex-image-in-cc
```

### From a local clone

```bash
git clone https://github.com/KingGyuSuh/codex-image-in-cc.git
cd codex-image-in-cc
claude plugin marketplace add "$PWD"
claude plugin install codex-image@codex-image-in-cc
```

Then restart Claude Code if needed. Default install scope is `user`; pass `--scope project` or `--scope local` to limit installation.

## Usage

```bash
/codex-image:status
/codex-image:generate --out images/library.png --size 1024x1024 "A watercolor moonlit library"
/codex-image:generate --ref style.png --ref "character ref.png" --out images/scene.png "A 9:16 scene using those references"
/codex-image:edit --out edited.png input.png "Replace the background with a clean white studio backdrop"
/codex-image:batch manifest.json --parallel 2
```

### Flags (`generate`, `edit`)

Flags go before the prompt (for `edit`: before the input path). `--` ends flags; `--flag=value` works; an unknown `--xyz` starts the prompt.

| Flag | Meaning |
|---|---|
| `--out <path>` | A file (`.png`, `.jpg`, `.jpeg`, any case; `.webp` and other extensions are rejected because sips cannot write them) or otherwise a directory (a path without an extension). Default: `./codex-images/<UTC-timestamp>-<n>.png` (edit: `...-edit-<n>.png`). Parent dirs are created. Several images into one file path become `<stem>-1`, `<stem>-2`. |
| `--force` | Overwrite an existing `--out` file (file targets only; directory targets always get new versioned names). Default: never overwrite; use `hero-v2.png`, `hero-v3.png`. |
| `--size <W>x<H>` | Exact final size (max 8192): scale to cover, then center-crop. Needs macOS `sips`; otherwise a warning is printed and the file is kept as is. |
| `--transparent` | Request a transparent background. |
| `--ref <path>` | Reference image (also `--reference`, `--image`; generate only; max 5; must exist). |
| `--mode direct\|skill` | `direct` (default, `CODEX_IMAGE_MODE`): call the image tool directly. `skill`: use Codex's imagegen skill. |
| `--effort <e>` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` (`CODEX_IMAGE_EFFORT`). Default low (direct) / medium (skill). `minimal` and `none` are rejected. |
| `--model <slug>` | Model for the turn (`CODEX_IMAGE_MODEL`). Default: none, so Codex uses the account default. |

A leading `~/` in a path means your home directory. Quote paths with spaces inside slash-command arguments (an unterminated quote is an error) (on the CLI the shell already keeps each argv element as one token). `--transparent` with a `.jpg` out warns, since JPEG drops alpha. The built-in tool has no size parameter (it returns for example 1254x1254), which is why `--size` is applied by the wrapper.

### Output

stdout carries only these lines (progress goes to stderr):

```
SAVED: <absolute path>
INFO: <absolute path> <W>x<H> alpha=<yes|no> source=<generated path>     (when sips is available)
USAGE: mode=<m> model=<slug|account-default> effort=<e> secs=<n> input=<n> cached=<n> output=<n> thread=<id>
```

Exit 0 if at least one image was saved (even if Codex itself exited non-zero), otherwise 1 with a reason on stderr. A turn is cut off after `CODEX_IMAGE_TIMEOUT_MS` (default 540000).

### Batch

`batch <manifest.json> [--mode m] [--effort e] [--model s] [--parallel N]`, where the manifest is a JSON array (max 20) of:

```json
[
  { "prompt": "a brass compass on white", "out": "logos/compass.png", "size": "512x512" },
  { "prompt": "make it blue", "edit": "logos/compass.png", "out": "logos/compass-blue.png" },
  { "prompt": "poster in this style", "refs": ["style.png"], "transparent": false, "force": true }
]
```

Relative paths resolve against the manifest's folder. The manifest is validated completely before anything runs. `--parallel` is 1 (default) to 3. stdout gets each item's `SAVED:` / `INFO:` lines, `ITEM <n> ok|failed <reason>`, and a final `USAGE: batch items=<n> ok=<k> secs=<s>`. Exit 0 if all items succeeded, 2 if some failed, 1 if none.

### Command line

`scripts/codex-image.mjs` is also a CLI (`bin: codex-image`). Put a symlink on your PATH:

```bash
ln -s "$PWD/scripts/codex-image.mjs" ~/.local/bin/codex-image
codex-image generate --out ~/Pictures/fox.png "a fox in the snow"
```

## Image home (`~/.codex-image`)

Image runs use their own `CODEX_HOME` so a heavy personal Codex config (plugins, MCP servers, many skills) does not inflate every image turn. Resolution order: `CODEX_IMAGE_HOME`, then `~/.codex-image` if that directory exists, then an inherited `CODEX_HOME`, then `~/.codex`. Generated files are looked up under `<home>/generated_images/<thread_id>/`. `status` shows which one is used.

Create the dedicated home once (it reuses your existing login):

```bash
mkdir ~/.codex-image && ln -s ~/.codex/auth.json ~/.codex-image/auth.json
cat > ~/.codex-image/config.toml <<'TOML'
# Minimal config for image runs. No model pin: the account default is used.
approval_policy = "never"
sandbox_mode = "workspace-write"
TOML
```

Do not pin `model` in that file unless you want to; the wrapper only passes `-m` when you give `--model` or `CODEX_IMAGE_MODEL`. Skill mode needs the imagegen skill under `<home>/skills/.system/imagegen/`; Codex installs it on first run.

## Cost and speed

Measured on codex-cli 0.172.0 with a ChatGPT login: direct mode at effort low is about 35 s and 37k input tokens (24k cached) per image; skill mode at medium about 47 s and 85k tokens; the old skill path at high was a median 82 s and about 138k tokens. Image generation always consumes a Codex agent turn plus the built-in image tool usage.

## Development

```bash
npm test
npm run validate:plugin
npm run status
claude --plugin-dir .
```

After editing plugin skills during a `claude --plugin-dir .` session, run `/reload-plugins`.

Image generation consumes a Codex agent turn plus the built-in image generation tool usage.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for scope, dev setup, and PR conventions, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the call flow and load-bearing edge cases. Security issues — see [`SECURITY.md`](SECURITY.md).

## License

[Apache-2.0](LICENSE).
