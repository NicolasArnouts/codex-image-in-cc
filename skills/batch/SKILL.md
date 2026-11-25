---
description: Generate or edit several images from a JSON manifest, optionally in parallel
argument-hint: '<manifest.json> [--parallel N] [--mode direct|skill] [--effort <e>] [--model <slug>]'
allowed-tools: Bash(node:*)
---

# Batch Codex Images

The manifest is a JSON array (max 20 items) of `{ "prompt": str, "out"?: str, "refs"?: [str], "edit"?: str, "size"?: "WxH", "transparent"?: bool, "force"?: bool }`. `edit` is an input image path (makes the item an edit; cannot be combined with `refs`). Relative paths resolve against the manifest's folder. The whole manifest is validated before anything runs. `--parallel N` runs up to N turns at once (default 1, max 3).

A batch takes roughly 30-90 seconds per image divided by the parallelism. Run it with `run_in_background` and a 10-minute Bash timeout (600000 ms) for long manifests; otherwise use a 10-minute timeout.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-image.mjs" batch "$ARGUMENTS"
```

Output rules:
- Show only the `SAVED:`, `INFO:`, `ITEM <n> ok|failed ...` and `USAGE:` lines from stdout to the user.
- Exit code 0 means every item succeeded, 2 some failed, 1 none (or an invalid manifest). On non-zero, show stderr and the failed `ITEM` lines; do not retry unless the user asks.
