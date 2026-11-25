---
description: Edit an image through Codex CLI's built-in image generation tool
argument-hint: '[--out <path>] [--size <W>x<H>] [--transparent] [--mode direct|skill] [--force] <input-path> <natural-language edit request>'
allowed-tools: Bash(node:*)
---

# Edit Codex Image

Flags come first, then the input image path (the first token after the flags), then the edit prompt. Quote the path if it contains spaces (e.g. `"my photo.png" make it red`).

- `--out <path>`: a file (`.png`, `.jpg`, `.jpeg`; other extensions are rejected) or a directory. Prefer an absolute path. Default: `./codex-images/<UTC-timestamp>-edit-<n>.png`. An existing file is never overwritten (a `-v2` sibling is used) unless `--force`.
- `--size <W>x<H>`, `--transparent`, `--mode direct|skill`, `--effort <e>`, `--model <slug>`: as for generate.

This command runs a Codex agent turn and typically takes 30-90 seconds. Run it with a 10-minute Bash timeout (600000 ms). For more than about 3 edits use `/codex-image:batch` (manifest items with an `edit` field) with `run_in_background`.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" edit --args-stdin <<'CODEX_IMAGE_ARGS'
$ARGUMENTS
CODEX_IMAGE_ARGS
```

Run this block exactly as written: do not alter the heredoc, its delimiter or the arguments line (the quoted delimiter stops the shell from expanding `$`, backticks and quotes in the prompt). Inside the arguments, wrap any path that contains spaces in single or double quotes.

Output rules:
- Show only the `SAVED:`, `INFO:` and `USAGE:` lines from stdout to the user.
- If the exit code is non-zero, show stderr and stop. Common failures: missing input image, missing edit prompt.
- Do not run any additional image edits unless the user explicitly asks for another attempt.
