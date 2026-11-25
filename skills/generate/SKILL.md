---
description: Generate one or more images, optionally with reference images, through Codex CLI's built-in image generation tool
argument-hint: '[--out <path>] [--size <W>x<H>] [--transparent] [--ref <image> ...] [--mode direct|skill] [--effort <e>] [--force] <image request>'
allowed-tools: Bash(node:*)
---

# Generate Codex Image

Leading flags (before the prompt; `--` ends flags):

- `--out <path>`: a file (`.png`, `.jpg`, `.jpeg`; other extensions are rejected) or a directory. Prefer an absolute path. Default: `./codex-images/<UTC-timestamp>-<n>.png`. An existing file is never overwritten (a `-v2`, `-v3` sibling is used) unless `--force`.
- `--size <W>x<H>`: exact final pixel size (scaled to cover, then center-cropped; needs macOS `sips`).
- `--transparent`: request a transparent background.
- `--ref <path>` (also `--reference`, `--image`): reference image, repeatable, max 5. Quote paths with spaces.
- `--mode direct|skill` (default `direct`, fast), `--effort <low|medium|high|xhigh|max|ultra>`, `--model <slug>` (default: account default).

This command runs a Codex agent turn and typically takes 30-90 seconds per image. Run it with a 10-minute Bash timeout (600000 ms). For more than about 3 images use `/codex-image:batch` with `run_in_background` instead of repeated calls.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" generate --args-stdin <<'CODEX_IMAGE_ARGS'
$ARGUMENTS
CODEX_IMAGE_ARGS
```

Run this block exactly as written: do not alter the heredoc, its delimiter or the arguments line (the quoted delimiter stops the shell from expanding `$`, backticks and quotes in the prompt). Inside the arguments, wrap any path that contains spaces in single or double quotes.

Output rules:
- Show only the `SAVED:`, `INFO:` and `USAGE:` lines from stdout to the user; progress goes to stderr and need not be repeated.
- If the exit code is non-zero, show stderr and stop.
- Do not run any additional image generation unless the user explicitly asks for another attempt.
