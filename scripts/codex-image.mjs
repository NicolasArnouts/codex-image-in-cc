#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MIN_NODE_VERSION = "18.18.0";
const MIN_CODEX_VERSION = "0.142.0";
// Contract cap of the Codex built-in image tool: at most 5 reference images per
// request (schema-enforced via `referenced_image_paths` since codex 0.144).
const MAX_REFERENCE_IMAGES = 5;
const MAX_DIMENSION = 8192;
const MAX_BATCH_ITEMS = 20;
const MAX_BATCH_PARALLEL = 3;
// Under Claude Code's 10-minute Bash cap.
const DEFAULT_TIMEOUT_MS = 540_000;
const STDERR_TAIL_CHARS = 4000;

// Extensions of images codex may leave under generated_images/.
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
// Extensions we can WRITE. macOS sips cannot encode webp ("Can't write format").
const OUT_EXTENSIONS = [".png", ".jpg", ".jpeg"];
const MODES = ["direct", "skill"];
// minimal / none hard-400 on the image turn, so they are not accepted.
const VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const DEFAULT_EFFORT = { direct: "low", skill: "medium" };

// Base headless exec invocation shared by generate and edit.
//
// `--full-auto` was removed from `codex exec` in 0.151; `--sandbox workspace-write` is the
// same sandbox policy. The explicit `-c approval_policy="never"` is load-bearing: bare
// `--sandbox workspace-write` drops the headless approval-never default when the user's
// config sets `approvals_reviewer = "auto_review"`. `--json` makes stdout a JSONL event
// stream the wrapper parses (thread id, usage, messages, errors).
const CODEX_EXEC_BASE_ARGS = [
  "exec",
  "--json",
  "--sandbox",
  "workspace-write",
  "-c",
  'approval_policy="never"',
  "--skip-git-repo-check"
];

// On Windows, `spawn("codex", ...)` misses the npm `codex.cmd` shim (ENOENT) and
// Node 20+ refuses to spawn `.cmd` directly without a shell (EINVAL, post
// CVE-2024-27980 hardening). Shelling out would re-expose user prompts to cmd.exe
// parsing, so resolve the shim to its codex.js entry and run it with node.exe.
function resolveCodex() {
  if (process.platform !== "win32") {
    return { command: "codex", prefix: [] };
  }
  const whereResult = spawnSync("where.exe", ["codex.cmd"], {
    encoding: "utf8",
    windowsHide: true
  });
  const cmdPath = String(whereResult.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (cmdPath) {
    const jsPath = path.join(path.dirname(cmdPath), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (fs.existsSync(jsPath)) {
      return { command: process.execPath, prefix: [jsPath] };
    }
  }
  return { command: "codex.cmd", prefix: [] };
}

// Test hook: CODEX_IMAGE_CODEX_BIN is an absolute path to an executable that stands in
// for codex. Resolved per call (not at import) so tests can set the env late.
function getCodex(env = process.env) {
  const override = env.CODEX_IMAGE_CODEX_BIN;
  if (override && process.platform !== "win32") {
    return { command: override, prefix: [] };
  }
  return resolveCodex();
}

function parseSemver(text) {
  const match = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return match.slice(1, 4).map((part) => Number.parseInt(part, 10));
}

function compareSemver(a, b) {
  const left = Array.isArray(a) ? a : parseSemver(a);
  const right = Array.isArray(b) ? b : parseSemver(b);
  if (!left || !right) {
    return null;
  }
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) {
      return 1;
    }
    if (left[index] < right[index]) {
      return -1;
    }
  }
  return 0;
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "").replace("T", "-");
}

// ---------------------------------------------------------------------------
// Home, model, effort, mode resolution
// ---------------------------------------------------------------------------

// CODEX_IMAGE_HOME > ~/.codex-image (if it exists) > inherited CODEX_HOME > ~/.codex
function resolveCodexHome({ env = process.env, homedir = os.homedir(), exists = fs.existsSync } = {}) {
  if (env.CODEX_IMAGE_HOME) {
    return { path: path.resolve(env.CODEX_IMAGE_HOME), source: "CODEX_IMAGE_HOME", dedicated: false };
  }
  const dedicated = path.join(homedir, ".codex-image");
  if (exists(dedicated)) {
    return { path: dedicated, source: "~/.codex-image", dedicated: true };
  }
  if (env.CODEX_HOME) {
    return { path: path.resolve(env.CODEX_HOME), source: "CODEX_HOME", dedicated: false };
  }
  return { path: path.join(homedir, ".codex"), source: "~/.codex", dedicated: false };
}

function validateEffort(value, label = "effort") {
  const effort = String(value ?? "").trim().toLowerCase();
  if (!VALID_EFFORTS.includes(effort)) {
    const extra = effort === "minimal" || effort === "none" ? ` (${effort} is rejected by the image turn with HTTP 400)` : "";
    throw new Error(`Invalid ${label} "${value}"${extra}; expected one of ${VALID_EFFORTS.join("|")}.`);
  }
  return effort;
}

function validateMode(value, label = "mode") {
  const mode = String(value ?? "").trim().toLowerCase();
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid ${label} "${value}"; expected ${MODES.join("|")}.`);
  }
  return mode;
}

function parseSize(value) {
  const match = String(value ?? "").trim().match(/^(\d+)x(\d+)$/i);
  const width = match ? Number.parseInt(match[1], 10) : 0;
  const height = match ? Number.parseInt(match[2], 10) : 0;
  if (!match || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`Invalid size "${value}"; expected <W>x<H> with positive integers up to ${MAX_DIMENSION}.`);
  }
  return { width, height };
}

// Flag > env > default. model has no default (account default => no -m).
function resolveRunSettings(options = {}, env = process.env) {
  const mode = validateMode(options.mode || env.CODEX_IMAGE_MODE || "direct", options.mode ? "--mode" : "CODEX_IMAGE_MODE");
  const effortRaw = options.effort || env.CODEX_IMAGE_EFFORT;
  const effort = effortRaw
    ? validateEffort(effortRaw, options.effort ? "--effort" : "CODEX_IMAGE_EFFORT")
    : DEFAULT_EFFORT[mode];
  const model = (options.model || env.CODEX_IMAGE_MODEL || "").trim() || null;
  return { mode, effort, model };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

// Split the first (optionally quoted) token off a raw argument string. Inside quotes,
// \" and \' are unescaped. `--flag="quoted value"` yields `--flag=quoted value`.
function unescapeQuotes(text) {
  return text.replace(/\\(["'])/g, "$1");
}

function splitFirstToken(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return { input: null, prompt: null };
  }
  const quoted = text.match(/^(['"])((?:\\.|(?!\1).)+)\1(?:\s+([\s\S]+))?$/);
  if (quoted) {
    return { input: unescapeQuotes(quoted[2]), prompt: (quoted[3] ?? "").trim() };
  }
  const inlineQuoted = text.match(/^(--[\w-]+)=(['"])((?:\\.|(?!\2).)+)\2(?:\s+([\s\S]+))?$/);
  if (inlineQuoted) {
    return { input: `${inlineQuoted[1]}=${unescapeQuotes(inlineQuoted[3])}`, prompt: (inlineQuoted[4] ?? "").trim() };
  }
  // A token that opens a quote it never closes: flag values and edit inputs reject it
  // (`--out "unterminated a cat` must not become a literal `"unterminated` folder).
  const unterminated = /^(['"])/.test(text) || /^--[\w-]+=['"]/.test(text);
  const unquoted = text.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (unquoted) {
    if (unterminated) {
      return { input: unquoted[1], prompt: (unquoted[2] ?? "").trim(), unterminated: true };
    }
    return { input: unquoted[1], prompt: (unquoted[2] ?? "").trim() };
  }
  return { input: null, prompt: null };
}

// Argument source. A single string (slash-command text, --args-stdin) is split with
// splitFirstToken and the remainder stays raw text. An array (a real shell argv) treats
// every element as exactly one token, so quoting done by the shell survives; the
// remaining elements joined with spaces form the prompt.
function makeSource(input) {
  if (Array.isArray(input) && input.length !== 1) {
    let index = 0;
    return {
      peek: () => (index < input.length ? String(input[index]) : null),
      take: () => (index < input.length ? String(input[index++]) : null),
      skipTerminator: () => {
        index += 1;
      },
      rest: () => input.slice(index).join(" ").trim()
    };
  }
  let rest = String((Array.isArray(input) ? input[0] : input) ?? "").trim();
  return {
    peek: () => splitFirstToken(rest).input,
    // strict: the token is a value (flag value, edit input, batch token), so an
    // unterminated quote is an error instead of a literal quote character.
    take: ({ strict = false } = {}) => {
      const first = splitFirstToken(rest);
      if (strict && first.unterminated) {
        throw new Error(`Unterminated quote in ${JSON.stringify(first.input)}; close the quote or escape it.`);
      }
      rest = first.prompt ?? "";
      return first.input;
    },
    skipTerminator: () => {
      rest = splitFirstToken(rest).prompt ?? "";
    },
    rest: () => rest.trim()
  };
}

const REFERENCE_IMAGE_FLAGS = new Set(["--ref", "--reference", "--image"]);
const VALUE_FLAGS = new Set(["--out", "--size", "--mode", "--effort", "--model"]);
const BOOLEAN_FLAGS = new Set(["--transparent", "--force"]);

// Parse leading flags off `raw`. `kind` is "generate" (reference flags allowed) or
// "edit". Stops at the first non-flag token (an unknown `--xyz` starts the prompt) or
// at `--`. Returns { options, rest } where rest is the unparsed remainder.
function parseLeadingFlags(input, kind) {
  const source = makeSource(input);
  const options = {
    referenceImages: [],
    out: null,
    size: null,
    transparent: false,
    mode: null,
    effort: null,
    model: null,
    force: false
  };

  for (;;) {
    const token = source.peek();
    if (!token) {
      break;
    }
    if (token === "--") {
      source.skipTerminator();
      break;
    }
    let name = token;
    let inlineValue = null;
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    if (eq > 0) {
      name = token.slice(0, eq);
      inlineValue = token.slice(eq + 1);
    }
    const isReference = kind === "generate" && REFERENCE_IMAGE_FLAGS.has(name);

    if (BOOLEAN_FLAGS.has(name) && inlineValue === null) {
      source.take();
      if (name === "--transparent") {
        options.transparent = true;
      } else {
        options.force = true;
      }
      continue;
    }

    if (isReference || VALUE_FLAGS.has(name)) {
      source.take({ strict: inlineValue !== null });
      let value = inlineValue;
      if (value === null) {
        value = source.peek();
        if (value && value.startsWith("--")) {
          value = null;
        } else if (value) {
          source.take({ strict: true });
        }
      }
      if (!value) {
        throw new Error(`Missing value for ${name}.`);
      }
      if (isReference) {
        options.referenceImages.push(value);
      } else if (name === "--out") {
        options.out = value;
      } else if (name === "--size") {
        options.size = parseSize(value);
      } else if (name === "--mode") {
        options.mode = validateMode(value, "--mode");
      } else if (name === "--effort") {
        options.effort = validateEffort(value, "--effort");
      } else if (name === "--model") {
        options.model = value;
      }
      continue;
    }

    break;
  }

  if (options.referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `Too many reference images (${options.referenceImages.length}). The built-in image generation tool accepts at most ${MAX_REFERENCE_IMAGES} per request — pass the ${MAX_REFERENCE_IMAGES} most relevant.`
    );
  }
  return { options, source, rest: source.rest() };
}

function parseGenerateArguments(raw) {
  const { options, rest } = parseLeadingFlags(raw, "generate");
  return { ...options, prompt: rest };
}

// edit [flags] <input> <prompt>
function parseEditArguments(raw) {
  const { options, source } = parseLeadingFlags(raw, "edit");
  const input = source.take({ strict: true });
  return { ...options, input: input ?? null, prompt: source.rest() };
}

// Tokens for `batch`: a real argv (more than one element) is used as is, a single
// string is split with the quote-aware tokenizer.
function tokenize(input) {
  if (Array.isArray(input) && input.length !== 1) {
    return input.map(String);
  }
  const tokens = [];
  const source = makeSource(input);
  for (let token = source.take({ strict: true }); token; token = source.take({ strict: true })) {
    tokens.push(token);
  }
  return tokens;
}

function parseBatchArguments(raw) {
  // A lone argv element that is an existing file is the manifest path as is (it may
  // contain spaces); any other lone string is split by the quote-aware tokenizer.
  const lone = Array.isArray(raw) && raw.length === 1 && fs.existsSync(resolveUserPath(process.cwd(), String(raw[0])));
  const tokens = lone ? [String(raw[0])] : tokenize(raw);
  const options = { manifest: null, mode: null, effort: null, model: null, parallel: 1 };
  for (let index = 0; index < tokens.length; index += 1) {
    let name = tokens[index];
    let inlineValue = null;
    const eq = name.startsWith("--") ? name.indexOf("=") : -1;
    if (eq > 0) {
      inlineValue = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (["--mode", "--effort", "--model", "--parallel"].includes(name)) {
      let value = inlineValue;
      if (value === null) {
        value = tokens[index + 1];
        index += 1;
      }
      if (!value || value.startsWith("--")) {
        throw new Error(`Missing value for ${name}.`);
      }
      if (name === "--mode") {
        options.mode = validateMode(value, "--mode");
      } else if (name === "--effort") {
        options.effort = validateEffort(value, "--effort");
      } else if (name === "--model") {
        options.model = value;
      } else {
        const parallel = Number.parseInt(value, 10);
        if (!/^\d+$/.test(value) || parallel < 1 || parallel > MAX_BATCH_PARALLEL) {
          throw new Error(`Invalid --parallel "${value}"; expected an integer 1-${MAX_BATCH_PARALLEL}.`);
        }
        options.parallel = parallel;
      }
      continue;
    }
    if (name.startsWith("--")) {
      throw new Error(`Unknown batch option ${name}.`);
    }
    if (options.manifest) {
      throw new Error(`Unexpected extra argument "${name}".`);
    }
    options.manifest = name;
  }
  return options;
}

// A leading `~/` (or a bare `~`) means the home directory, as in a shell. Slash-command
// text and manifests never pass through a shell, so without this `--out ~/x.png` would
// create a literal `./~/` folder.
function expandHome(file, homedir = os.homedir()) {
  const text = String(file);
  if (text === "~") {
    return homedir;
  }
  if (text.startsWith("~/")) {
    return path.join(homedir, text.slice(2));
  }
  return text;
}

function resolveUserPath(base, file) {
  return path.resolve(base, expandHome(file));
}

function resolveExistingImagePaths(inputs, cwd, label) {
  return inputs.map((input) => {
    const resolved = resolveUserPath(cwd, input);
    if (!fs.existsSync(resolved)) {
      throw new Error(`${label} image not found: ${resolved}`);
    }
    return resolved;
  });
}

// ---------------------------------------------------------------------------
// Out-path planning
// ---------------------------------------------------------------------------

function hasImageExtension(file) {
  return IMAGE_EXTENSIONS.includes(path.extname(String(file)).toLowerCase());
}

// `--out` ending in .png/.jpg/.jpeg (any case) is a file. A last segment with any other
// dot-extension (.gif, .tiff, .webp ...) is an error, not a directory. Otherwise it is a
// directory. Omitted: <cwd>/codex-images/.
function resolveOutTarget(out, cwd) {
  if (!out) {
    return { kind: "dir", path: path.resolve(cwd, "codex-images"), dir: path.resolve(cwd, "codex-images") };
  }
  const resolved = resolveUserPath(cwd, out);
  const ext = path.extname(resolved).toLowerCase();
  if (OUT_EXTENSIONS.includes(ext)) {
    return { kind: "file", path: resolved, dir: path.dirname(resolved) };
  }
  if (ext) {
    const hint =
      ext === ".webp" ? " (macOS sips cannot write webp)" : "";
    throw new Error(`Unsupported --out extension "${ext}"${hint}; use ${OUT_EXTENSIONS.join(", ")} for a file, or a directory path without an extension.`);
  }
  return { kind: "dir", path: resolved, dir: resolved };
}

// hero.png exists -> hero-v2.png, then hero-v3.png ...
function versionedPath(file, exists = fs.existsSync) {
  if (!exists(file)) {
    return file;
  }
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let version = 2; ; version += 1) {
    const candidate = `${stem}-v${version}${ext}`;
    if (!exists(candidate)) {
      return candidate;
    }
  }
}

// Atomically reserve a unique file name: create an empty placeholder with O_EXCL and move
// to the next -vN on EEXIST. The caller owns the placeholder and must either rename an
// image onto it or remove it. With force the exact path is returned without a placeholder.
function reserveFile(file, { force = false } = {}) {
  if (force) {
    return file;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ext = path.extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let version = 1; ; version += 1) {
    const candidate = version === 1 ? file : `${stem}-v${version}${ext}`;
    try {
      fs.closeSync(fs.openSync(candidate, "wx"));
      return candidate;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
  }
}

function dirNamePrefix(timestamp, edit) {
  return `${timestamp}-${edit ? "edit-" : ""}`;
}

// Destination files for `count` images (pure; used for planning and tests). Never
// overwrites unless force.
function planDestinations({ target, count, edit = false, timestamp = timestampForFile(), force = false, exists = fs.existsSync }) {
  const pick = (file) => (force ? file : versionedPath(file, exists));
  const destinations = [];
  if (target.kind === "file") {
    if (count <= 1) {
      return [pick(target.path)];
    }
    const ext = path.extname(target.path);
    const stem = target.path.slice(0, target.path.length - ext.length);
    for (let index = 1; index <= count; index += 1) {
      destinations.push(pick(`${stem}-${index}${ext}`));
    }
    return destinations;
  }
  for (let index = 1; index <= count; index += 1) {
    // Directory defaults are always versioned (a same-second rerun must not overwrite).
    destinations.push(versionedPath(path.join(target.path, `${dirNamePrefix(timestamp, edit)}${index}.png`), exists));
  }
  return destinations;
}

// ---------------------------------------------------------------------------
// Instructions (pure)
// ---------------------------------------------------------------------------

function transparentHint(transparent) {
  return transparent
    ? "Set transparent_background to true."
    : "Set transparent_background to true only if the request asks for transparency.";
}

function sizeHint(size) {
  return size ? `The caller will crop/resize to ${size.width}x${size.height}, so compose for a ${size.width}:${size.height} aspect ratio.` : "";
}

function joinParagraphs(parts) {
  return parts.filter(Boolean).join("\n");
}

function buildDirectGenerateInstruction({ prompt, referenceImagePaths = [], transparent = false, size = null }) {
  const refs = referenceImagePaths.length
    ? `Pass these absolute paths as referenced_image_paths:\n${referenceImagePaths.join("\n")}\nThey are references, not edit targets.`
    : "";
  return `${joinParagraphs([
    "Generate the image(s) with your built-in image generation tool (image_gen.imagegen). Do not read skill files or any other files, do not run shell commands, and do not copy, move or resize anything: the caller handles files.",
    `Pass the request below as the prompt unchanged. ${transparentHint(transparent)}`,
    refs,
    sizeHint(size),
    "If the request asks for several images or variants, call the tool once per image.",
    "When the tool has finished, reply with exactly one line: DONE."
  ])}

Request:

${prompt}`;
}

function buildDirectEditInstruction({ inputPath, prompt, transparent = false, size = null }) {
  return `${joinParagraphs([
    `Edit the image at ${inputPath} with your built-in image generation tool (pass it in referenced_image_paths). Preserve everything the request does not ask to change.`,
    "Do not read skill files or any other files, do not run shell commands, and do not copy, move or resize anything: the caller handles files.",
    `Pass the request below as the prompt unchanged. ${transparentHint(transparent)}`,
    sizeHint(size),
    "If the request asks for several images or variants, call the tool once per image.",
    "When the tool has finished, reply with exactly one line: DONE."
  ])}

Edit request:

${prompt}`;
}

function formatReferenceImages(referenceImagePaths) {
  if (referenceImagePaths.length === 0) {
    return "";
  }
  const lines = referenceImagePaths.map((imagePath, index) => `${index + 1}. ${imagePath}`);
  return `\nReference images for generation (also attached to this turn via codex exec --image):\n${lines.join("\n")}\n\nThese are generation references, not edit targets. If your built-in image generation tool accepts local image paths (codex 0.144+, referenced_image_paths), pass the absolute paths above so the reference pixels condition the output directly; otherwise use the attachments as visual context for style, identity, composition, mood, or subject guidance according to the user's prompt. Do not modify or overwrite the referenced files.\n`;
}

// outTarget.reserved is the concrete, already reserved (empty placeholder) file name.
function skillSaveParagraph(outTarget, edit) {
  const first = outTarget.reserved ?? (outTarget.kind === "file" ? outTarget.path : path.join(outTarget.path, `${outTarget.prefix ?? dirNamePrefix("<UTC-timestamp>", edit)}1.png`));
  const note = outTarget.force
    ? "overwrite it"
    : "an empty placeholder was created there for you: replace it";
  let where;
  if (outTarget.kind === "file") {
    const ext = path.extname(first);
    const stem = first.slice(0, first.length - ext.length);
    where = `Save the final image to exactly ${first} (${note}). If you produce several images, save the others next to it as ${stem}-2${ext}, ${stem}-3${ext}, ...`;
  } else {
    where = `Save the final image(s) into ${outTarget.path}: the first as exactly ${first} (${note}), further ones as ${outTarget.path}/${outTarget.prefix ?? dirNamePrefix("<UTC-timestamp>", edit)}<n>.png (n=2,3,...)`;
  }
  return `${where}\nNever overwrite any other existing file, and create no other copies.\n\nFor each saved image, print exactly one line:\nSAVED: <absolute path>`;
}

function skillHints({ transparent, size }) {
  const parts = [];
  if (transparent) {
    parts.push("The image must have a transparent background.");
  }
  if (size) {
    parts.push(`The caller will crop/resize to ${size.width}x${size.height}, so compose for a ${size.width}:${size.height} aspect ratio.`);
  }
  return parts.length ? `\n${parts.join("\n")}\n` : "";
}

function buildSkillGenerateInstruction({ prompt, referenceImagePaths = [], outTarget, transparent = false, size = null }) {
  return `Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback (no OPENAI_API_KEY required).

${skillSaveParagraph(outTarget, false)}
${skillHints({ transparent, size })}${formatReferenceImages(referenceImagePaths)}
User request:

${prompt}`;
}

function buildSkillEditInstruction({ inputPath, prompt, outTarget, transparent = false, size = null }) {
  return `Use the imagegen skill. Built-in image_gen tool path only — do not use the CLI fallback (no OPENAI_API_KEY required).

The edit target image (also attached to this turn via codex exec --image):
${inputPath}

If your built-in image generation tool accepts local image paths (codex 0.144+, referenced_image_paths), pass the absolute path above as the edit reference. Preserve unrelated parts unless the user request says otherwise.

${skillSaveParagraph(outTarget, true)}
${skillHints({ transparent, size })}
User edit request:

${prompt}`;
}

// Dispatchers used by the job runner and tests.
function buildGenerateInstruction({ mode = "direct", ...rest }) {
  return mode === "skill" ? buildSkillGenerateInstruction(rest) : buildDirectGenerateInstruction(rest);
}

function buildEditInstruction({ mode = "direct", ...rest }) {
  return mode === "skill" ? buildSkillEditInstruction(rest) : buildDirectEditInstruction(rest);
}

// Absolute image paths mentioned in a prompt -> nearest EXISTING ancestor dir of each
// (deduped, never "/"), so skill mode (which writes files itself) can read/write there.
function extractPromptAddDirs(prompt, exists = fs.existsSync) {
  const dirs = new Set();
  const pattern = /(?:^|[\s"'`(\[])(\/[^\s"'`()<>\[\]]+?\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`)\],.;:])/gi;
  for (const match of String(prompt ?? "").matchAll(pattern)) {
    let dir = path.dirname(match[1]);
    while (dir && dir !== "/" && dir !== path.dirname(dir) && !exists(dir)) {
      dir = path.dirname(dir);
    }
    if (dir && dir !== "/" && exists(dir)) {
      dirs.add(dir);
    }
  }
  return [...dirs];
}

// codex exec argv for one image turn.
function buildCodexArgs({ cwd, effort, model = null, images = [], addDirs = [], lastMessageFile, instruction }) {
  const args = [...CODEX_EXEC_BASE_ARGS, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`];
  if (model) {
    args.push("-m", model);
  }
  for (const image of images) {
    args.push("--image", image);
  }
  args.push("-C", cwd);
  for (const dir of [...new Set(addDirs)]) {
    args.push("--add-dir", dir);
  }
  if (lastMessageFile) {
    args.push("-o", lastMessageFile);
  }
  args.push("--", instruction);
  return args;
}

// ---------------------------------------------------------------------------
// JSONL event stream
// ---------------------------------------------------------------------------

function createEventState() {
  return {
    threadId: null,
    messages: [],
    warnings: [],
    failures: [],
    usage: { input: 0, cached: 0, output: 0 }
  };
}

function parseJsonLine(line) {
  const text = String(line ?? "").trim();
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

// Apply one parsed event to `state`; return progress messages (strings) to print.
function applyCodexEvent(state, event) {
  const progress = [];
  if (!event || typeof event.type !== "string") {
    return progress;
  }
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    state.threadId = event.thread_id;
    progress.push(`thread ${event.thread_id} started`);
  } else if (event.type === "item.completed" && event.item) {
    const item = event.item;
    if (item.type === "agent_message" && typeof item.text === "string") {
      state.messages.push(item.text);
      progress.push(`codex: ${item.text.replace(/\s+/g, " ").slice(0, 200)}`);
    } else if (item.type === "error" && typeof item.message === "string") {
      if (!state.warnings.includes(item.message)) {
        state.warnings.push(item.message);
        progress.push(`warning: ${item.message.replace(/\s+/g, " ").slice(0, 160)}`);
      }
    }
  } else if (event.type === "turn.completed" && event.usage) {
    state.usage.input += Number(event.usage.input_tokens) || 0;
    state.usage.cached += Number(event.usage.cached_input_tokens) || 0;
    state.usage.output += Number(event.usage.output_tokens) || 0;
  } else if (event.type === "turn.failed" || event.type === "error") {
    const message = event.error?.message ?? event.message ?? "codex turn failed";
    state.failures.push(String(message));
    progress.push(`error: ${String(message).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return progress;
}

// Parse a whole JSONL text (fixtures, tests).
function parseCodexJsonl(text) {
  const state = createEventState();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    applyCodexEvent(state, parseJsonLine(line));
  }
  return state;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

function timeoutMs(env = process.env) {
  const value = Number.parseInt(env.CODEX_IMAGE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function killGraceMs(env = process.env) {
  const value = Number.parseInt(env.CODEX_IMAGE_KILL_GRACE_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : 5000;
}

// Line-buffered JSONL reader: a JSON line may be split across stdout chunks.
function createJsonlStreamer(state, emit) {
  let carry = "";
  const handle = (line) => {
    for (const message of applyCodexEvent(state, parseJsonLine(line))) {
      emit(message);
    }
  };
  return {
    feed(chunk) {
      const lines = (carry + chunk).split("\n");
      carry = lines.pop();
      lines.forEach(handle);
    },
    end() {
      handle(carry);
      carry = "";
    }
  };
}

// Run one codex turn. stdin is ignored (the stdin trap), stdout is parsed as JSONL,
// stderr is drained into a bounded tail. The child runs in its own process group
// (non-Windows) so a timeout kills codex and everything it spawned.
// Resolves { status, timedOut, state, stderrTail }.
function runCodexTurn({ args, cwd, home, label = "", onProgress }) {
  return new Promise((resolve, reject) => {
    if (interruptedBy) {
      reject(new Error(`interrupted by ${interruptedBy}`));
      return;
    }
    const codex = getCodex();
    const state = createEventState();
    const prefix = label ? `codex-image: [${label}] ` : "codex-image: ";
    const emit = onProgress ?? ((message) => process.stderr.write(`${prefix}${message}\n`));
    const streamer = createJsonlStreamer(state, emit);
    let stderrTail = "";
    let timedOut = false;
    let killTimer = null;
    let exitTimer = null;
    let settled = false;
    const useGroup = process.platform !== "win32";

    const child = spawn(codex.command, [...codex.prefix, ...args], {
      cwd,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
      detached: useGroup,
      windowsHide: true
    });
    const signalChild = (signal) => {
      try {
        if (useGroup && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };
    // If this wrapper itself exits, do not leave an orphaned codex group behind.
    const onParentExit = () => signalChild("SIGTERM");
    process.once("exit", onParentExit);
    // Registered so a signal to the wrapper can stop this child's whole process group.
    const handle = { signal: signalChild, exited: false };
    activeChildren.add(handle);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => streamer.feed(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    const limit = timeoutMs();
    const grace = killGraceMs();
    const timer = setTimeout(() => {
      timedOut = true;
      signalChild("SIGTERM");
      killTimer = setTimeout(() => signalChild("SIGKILL"), grace);
    }, limit);

    const finish = (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      process.removeListener("exit", onParentExit);
      activeChildren.delete(handle);
      streamer.end();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ status: status ?? (signal ? 1 : 0), timedOut, timeoutMs: limit, state, stderrTail });
    };

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(exitTimer);
      process.removeListener("exit", onParentExit);
      activeChildren.delete(handle);
      reject(error);
    });
    // 'close' waits for the pipes; a grandchild holding them open must not hang us.
    child.on("exit", (status, signal) => {
      handle.exited = true;
      exitTimer = setTimeout(() => finish(status, signal), 2000);
    });
    child.on("close", (status, signal) => finish(status, signal));
  });
}

// ---------------------------------------------------------------------------
// Signals: Ctrl-C / SIGTERM / SIGHUP must not leave codex running or files behind
// ---------------------------------------------------------------------------

// Codex runs detached in its own process group, so a terminal Ctrl-C (sent to the
// wrapper's foreground group) or a SIGTERM to the wrapper never reaches it. Every live
// child group and every job's cleanup state is registered here.
const activeChildren = new Set();
const activeJobContexts = new Set();
let interruptedBy = null;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
const SIGNAL_GRACE_MS = 3000;

function cleanupAllJobs() {
  for (const ctx of activeJobContexts) {
    cleanupJob(ctx);
  }
}

// SIGTERM every codex group, wait (bounded) for the leaders to exit, then SIGKILL every
// group anyway (a grandchild may ignore SIGTERM), remove unfilled placeholders, temp
// files and dirs this run created, and exit 128+signo. A second signal skips the wait.
async function handleTerminationSignal(signal) {
  const code = SIGNAL_EXIT_CODES[signal] ?? 1;
  const handles = [...activeChildren];
  if (interruptedBy) {
    for (const handle of handles) {
      handle.signal("SIGKILL");
    }
    cleanupAllJobs();
    process.exit(code);
  }
  interruptedBy = signal;
  process.stderr.write(`codex-image: ${signal} received; stopping codex and removing unfinished files\n`);
  for (const handle of handles) {
    handle.signal("SIGTERM");
  }
  const deadline = Date.now() + Math.min(killGraceMs(), SIGNAL_GRACE_MS);
  while (Date.now() < deadline && handles.some((handle) => !handle.exited)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const handle of handles) {
    handle.signal("SIGKILL");
  }
  cleanupAllJobs();
  process.exit(code);
}

function installSignalHandlers() {
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, () => {
      handleTerminationSignal(signal);
    });
  }
}

// ---------------------------------------------------------------------------
// sips (macOS) helpers
// ---------------------------------------------------------------------------

let sipsAvailable = null;
function hasSips() {
  if (sipsAvailable === null) {
    // Test hook: CODEX_IMAGE_DISABLE_SIPS=1 behaves like a machine without sips.
    if (process.platform !== "darwin" || process.env.CODEX_IMAGE_DISABLE_SIPS === "1") {
      sipsAvailable = false;
    } else {
      const result = spawnSync("sips", ["--help"], { stdio: "pipe", encoding: "utf8" });
      sipsAvailable = !(result.error && result.error.code === "ENOENT");
    }
  }
  return sipsAvailable;
}

function sipsInfo(file) {
  const result = spawnSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", file], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (result.status !== 0) {
    return null;
  }
  const width = Number.parseInt(result.stdout.match(/pixelWidth:\s*(\d+)/)?.[1] ?? "", 10);
  const height = Number.parseInt(result.stdout.match(/pixelHeight:\s*(\d+)/)?.[1] ?? "", 10);
  const alpha = result.stdout.match(/hasAlpha:\s*(\w+)/)?.[1] ?? "no";
  if (!width || !height) {
    return null;
  }
  return { width, height, alpha: alpha.toLowerCase() === "yes" };
}

// Scale to COVER the target, then center-crop to exactly W x H.
function applySize(file, size) {
  const info = sipsInfo(file);
  if (!info) {
    return false;
  }
  if (info.width === size.width && info.height === size.height) {
    return true;
  }
  const factor = Math.max(size.width / info.width, size.height / info.height);
  const scaledWidth = Math.max(size.width, Math.ceil(info.width * factor));
  const scaledHeight = Math.max(size.height, Math.ceil(info.height * factor));
  const resample = spawnSync("sips", ["--resampleHeightWidth", String(scaledHeight), String(scaledWidth), file], { stdio: "pipe" });
  if (resample.status !== 0) {
    return false;
  }
  const crop = spawnSync("sips", ["--cropToHeightWidth", String(size.height), String(size.width), file], { stdio: "pipe" });
  return crop.status === 0;
}

function convertImage(source, destination, format) {
  const result = spawnSync("sips", ["-s", "format", format, source, "--out", destination], { stdio: "pipe" });
  try {
    return result.status === 0 && detectImageFormat(destination) === format;
  } catch {
    return false;
  }
}

// Real format by magic bytes (the extension codex or a skill picked may lie). null for
// an unrecognized format; read errors (EACCES ...) are thrown.
function detectImageFormat(file) {
  const header = Buffer.alloc(12);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "jpeg";
  }
  if (header.subarray(0, 4).toString("latin1") === "RIFF" && header.subarray(8, 12).toString("latin1") === "WEBP") {
    return "webp";
  }
  return null;
}

function formatForExtension(file) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "png" : ext === ".jpg" || ext === ".jpeg" ? "jpeg" : null;
}

// ---------------------------------------------------------------------------
// Collect and finalize
// ---------------------------------------------------------------------------

function listImagesIn(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && hasImageExtension(full)) {
      files.push({ path: full, mtimeMs: fs.statSync(full).mtimeMs });
    }
  }
  return files;
}

// Process-wide bookkeeping so concurrent batch items never claim each other's output.
const claimedThreads = new Set();
const claimedPaths = new Set();
let activeJobs = 0;

function sortedPaths(files) {
  return files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path)).map((file) => file.path);
}

// A path's creation time, or null when the filesystem does not record one (then the
// creation order cannot be proven and nothing is attributed).
function birthtimeOf(stat) {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : null;
}

// Unclaimed thread dirs under generated_images that changed at or after `sinceMs`
// (no look-back), each with its creation time (null if unknown).
function findNewThreadDirs(home, sinceMs) {
  const root = path.join(home, "generated_images");
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
  return dirs
    .map((entry) => ({ name: entry.name, stat: fs.statSync(path.join(root, entry.name)) }))
    .filter(({ name, stat }) => !claimedThreads.has(name) && Math.max(stat.mtimeMs, birthtimeOf(stat) ?? 0) >= sinceMs)
    .map(({ name, stat }) => ({ name, born: birthtimeOf(stat) }));
}

// Does $CODEX_HOME/sessions/**/rollout-*-<threadId>.jsonl exist, created at or after
// `sinceMs`? That ties a thread dir to a session started by this spawn, not by an
// orphaned earlier run that is still writing images.
function hasRolloutSince(home, threadId, sinceMs) {
  const suffix = `-${threadId}.jsonl`;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) {
        if (walk(full, depth + 1)) {
          return true;
        }
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) {
        try {
          const born = birthtimeOf(fs.statSync(full));
          if (born !== null && born >= sinceMs) {
            return true;
          }
        } catch {
          // vanished
        }
      }
    }
    return false;
  };
  return walk(path.join(home, "sessions"), 0);
}

// Files codex generated for this turn, oldest first. Known thread id: that thread's dir.
// Missing thread id: only a single unclaimed thread dir CREATED at or after the spawn
// whose session rollout was also created after the spawn, and never while another job
// is running. Anything else that appeared is left where it is -> { error }.
function collectGeneratedImages(home, threadId, sinceMs) {
  const root = path.join(home, "generated_images");
  let id = threadId;
  if (!id) {
    const fresh = findNewThreadDirs(home, sinceMs);
    const attributable = fresh.filter(({ name, born }) => born !== null && born >= sinceMs && hasRolloutSince(home, name, sinceMs));
    if (attributable.length === 1 && fresh.length === 1 && activeJobs <= 1) {
      id = attributable[0].name;
    } else if (fresh.length > 0) {
      return {
        files: [],
        error: `no thread id from codex, so the generated image(s) cannot be attributed to this item unambiguously; image(s) left in ${root}`
      };
    }
  }
  if (!id) {
    return { files: [], error: null };
  }
  claimedThreads.add(id);
  return { files: sortedPaths(listImagesIn(path.join(root, id))), error: null };
}

function parseSavedLines(text) {
  const paths = [];
  for (const match of String(text ?? "").matchAll(/^\s*SAVED:\s*(.+?)\s*$/gm)) {
    paths.push(match[1]);
  }
  return paths;
}

function topLevelSnapshot(dir) {
  try {
    return new Set(fs.readdirSync(dir).map((name) => path.join(dir, name)));
  } catch {
    return new Set();
  }
}

// Skill-mode results: only files that have an image extension, sit inside the planned
// out dir, are non-empty, were modified after the spawn, were not claimed already, and
// either did not exist before the spawn or are the reserved placeholder we handed out.
function collectSkillResults({ outDir, reserved, candidates, snapshot, sinceMs }) {
  const results = [];
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (results.includes(abs) || claimedPaths.has(abs) || !hasImageExtension(abs)) {
      continue;
    }
    if (!abs.startsWith(outDir + path.sep)) {
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0 || stat.mtimeMs < sinceMs - 2000) {
      continue;
    }
    if (abs !== reserved && snapshot.has(abs)) {
      continue;
    }
    results.push(abs);
  }
  return results;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Content match between a final file and the generated candidates; null when unknown.
function matchSource(file, generated) {
  try {
    const size = fs.statSync(file).size;
    const hash = sha256(file);
    return generated.find((candidate) => fs.statSync(candidate).size === size && sha256(candidate) === hash) ?? null;
  } catch {
    return null;
  }
}

function removeIfEmpty(file) {
  try {
    if (fs.statSync(file).size === 0) {
      fs.unlinkSync(file);
    }
  } catch {
    // already gone
  }
}

// Remove directories this run created, innermost first, only while empty.
function removeCreatedDirs(root, leaf) {
  if (!root) {
    return;
  }
  for (let dir = leaf; dir.startsWith(root); dir = path.dirname(dir)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    if (dir === root) {
      return;
    }
  }
}

// Per-job cleanup state: every placeholder this job reserved, which of them got a final
// image, temp files and temp dirs, and the first directory this job created. Cleaned in
// the job's finally and by the signal handler, so no exit path leaves a 0-byte file.
function createJobContext() {
  return { placeholders: new Set(), filled: new Set(), temps: new Set(), tmpDirs: new Set(), createdRoot: null, outDir: null };
}

function cleanupJob(ctx) {
  for (const temp of ctx.temps) {
    fs.rmSync(temp, { force: true });
  }
  ctx.temps.clear();
  for (const dir of ctx.tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  ctx.tmpDirs.clear();
  for (const file of ctx.placeholders) {
    if (ctx.filled.has(file)) {
      continue;
    }
    if (interruptedBy) {
      // Interrupted: whatever is in a placeholder we reserved is unfinished.
      fs.rmSync(file, { force: true });
    } else {
      removeIfEmpty(file);
    }
  }
  ctx.placeholders.clear();
  removeCreatedDirs(ctx.createdRoot, ctx.outDir);
}

// Reserve `file` (O_EXCL, next -vN) and record it as this job's placeholder. With
// force (explicit file targets only) the exact path is used without a placeholder.
function reserveFor(ctx, file, force) {
  const reserved = reserveFile(file, { force });
  if (!force) {
    ctx.placeholders.add(reserved);
  }
  return reserved;
}

// Short temp name next to `destination` (a long destination basename must not push the
// temp name past NAME_MAX); keeps the extension so sips sees the right type.
function tempPathFor(destination) {
  return path.join(path.dirname(destination), `.codex-image-${crypto.randomBytes(6).toString("hex")}${path.extname(destination)}`);
}

// Write `source` to `destination` atomically: stage in a temp file inside the
// destination dir, convert when the real format (magic bytes) differs from the
// destination extension, resize, then rename onto the reserved placeholder. Throws when
// the image cannot be written in the requested format.
function materialize({ source, destination, size, warnings, ctx }) {
  const temp = tempPathFor(destination);
  ctx.temps.add(temp);
  try {
    const sourceFormat = detectImageFormat(source);
    const targetFormat = formatForExtension(destination);
    if (!sourceFormat) {
      throw new Error(`${source} is not a png, jpeg or webp image`);
    }
    if (sourceFormat !== targetFormat) {
      if (!hasSips()) {
        throw new Error(`${source} is ${sourceFormat} but ${destination} needs ${targetFormat}; converting needs macOS sips, which is not available (use --out with a .${sourceFormat === "jpeg" ? "jpg" : sourceFormat} name)`);
      }
      if (!convertImage(source, temp, targetFormat)) {
        throw new Error(`sips could not convert ${source} from ${sourceFormat} to ${targetFormat}`);
      }
    } else {
      fs.copyFileSync(source, temp);
    }
    if (size) {
      if (hasSips()) {
        if (!applySize(temp, size)) {
          warnings.push(`size not applied to ${destination} (sips failed)`);
        }
      } else {
        warnings.push("size not applied (sips not available)");
      }
    }
    fs.renameSync(temp, destination);
  } finally {
    fs.rmSync(temp, { force: true });
    ctx.temps.delete(temp);
  }
  return destination;
}

// A skill-mode file codex saved itself whose bytes do not match its extension is
// converted in place when sips is available.
function fixInPlaceFormat(file, warnings, ctx) {
  let actual;
  try {
    actual = detectImageFormat(file);
  } catch {
    return;
  }
  const wanted = formatForExtension(file);
  if (!actual || !wanted || actual === wanted) {
    return;
  }
  if (!hasSips()) {
    warnings.push(`${file} contains ${actual} data but has a .${path.extname(file).slice(1)} name (sips not available to convert)`);
    return;
  }
  const temp = tempPathFor(file);
  ctx.temps.add(temp);
  try {
    if (convertImage(file, temp, wanted)) {
      fs.renameSync(temp, file);
    } else {
      warnings.push(`could not convert ${file} from ${actual} to ${wanted}`);
    }
  } finally {
    fs.rmSync(temp, { force: true });
    ctx.temps.delete(temp);
  }
}

// ---------------------------------------------------------------------------
// One image job (generate / edit)
// ---------------------------------------------------------------------------

// job: { kind: "generate"|"edit", prompt, referenceImagePaths, inputPath, out, size,
//        transparent, mode, effort, model, force, cwd, label }
// Returns { ok, reason, stderrTail, lines: [stdout lines], saved, usageLine, warnings }.
async function runImageJob(job, options = {}) {
  activeJobs += 1;
  const ctx = createJobContext();
  activeJobContexts.add(ctx);
  try {
    return await runImageJobInner(job, options, ctx);
  } catch (error) {
    return { ok: false, reason: error.message, stderrTail: "", lines: [], saved: [], warnings: [] };
  } finally {
    // Whatever happened (success, codex failure, EACCES/ENOSPC while finalizing), no
    // placeholder that never got an image, temp file or created empty dir survives.
    cleanupJob(ctx);
    activeJobContexts.delete(ctx);
    activeJobs -= 1;
  }
}

async function runImageJobInner(job, { onProgress } = {}, ctx = createJobContext()) {
  const cwd = job.cwd ?? process.cwd();
  const settings = resolveRunSettings(job);
  const home = resolveCodexHome().path;
  const edit = job.kind === "edit";
  const outTarget = resolveOutTarget(job.out, cwd);
  // --force only means "overwrite this exact file". A directory target always gets
  // fresh, versioned timestamp names (a same-second rerun must not overwrite).
  const force = Boolean(job.force) && outTarget.kind === "file";
  const skill = settings.mode === "skill";
  const warnings = [];
  if (job.transparent && outTarget.kind === "file" && [".jpg", ".jpeg"].includes(path.extname(outTarget.path).toLowerCase())) {
    warnings.push("--transparent with a .jpg/.jpeg out: JPEG has no alpha channel, transparency is dropped");
  }

  ctx.createdRoot = fs.mkdirSync(outTarget.dir, { recursive: true }) ?? null;
  ctx.outDir = outTarget.dir;
  const prefix = dirNamePrefix(timestampForFile(), edit);
  const primary = outTarget.kind === "file" ? outTarget.path : path.join(outTarget.path, `${prefix}1.png`);
  // Skill mode: Codex writes the file itself, so it needs a concrete, already reserved
  // name up front. Direct mode reserves names only when the images are copied, so no
  // 0-byte file sits in the user's folder during the 30-90 s turn.
  const reserved = skill ? reserveFor(ctx, primary, force) : null;

  const skillTarget = { ...outTarget, reserved: reserved ?? primary, prefix, force };
  const common = { prompt: job.prompt, transparent: Boolean(job.transparent), size: job.size ?? null };
  const instruction = edit
    ? buildEditInstruction({ mode: settings.mode, inputPath: job.inputPath, outTarget: skillTarget, ...common })
    : buildGenerateInstruction({
        mode: settings.mode,
        referenceImagePaths: job.referenceImagePaths ?? [],
        outTarget: skillTarget,
        ...common
      });

  const addDirs = [outTarget.dir];
  if (skill) {
    addDirs.push(...extractPromptAddDirs(job.prompt));
  }
  const images = edit ? [job.inputPath] : job.referenceImagePaths ?? [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-"));
  ctx.tmpDirs.add(tmpDir);
  const lastMessageFile = path.join(tmpDir, "last-message.txt");
  const args = buildCodexArgs({
    cwd,
    effort: settings.effort,
    model: settings.model,
    images,
    addDirs,
    lastMessageFile,
    instruction
  });

  const snapshot = topLevelSnapshot(outTarget.dir);
  const startMs = Date.now();
  let turn;
  try {
    turn = await runCodexTurn({ args, cwd, home, label: job.label, onProgress });
  } catch (error) {
    return { ok: false, reason: `could not run codex: ${error.message}`, stderrTail: "", lines: [], saved: [], warnings };
  }
  if (interruptedBy) {
    return { ok: false, reason: `interrupted by ${interruptedBy}`, stderrTail: turn.stderrTail, lines: [], saved: [], warnings };
  }
  let lastText = turn.state.messages.join("\n");
  try {
    lastText += `\n${fs.readFileSync(lastMessageFile, "utf8")}`;
  } catch {
    // codex did not write the last-message file
  }

  const { files: generated, error: attribution } = collectGeneratedImages(home, turn.state.threadId, startMs);
  if (attribution) {
    return { ok: false, reason: attribution, stderrTail: turn.stderrTail, lines: [], saved: [], warnings };
  }

  let finals = [];
  if (skill) {
    const results = collectSkillResults({
      outDir: outTarget.dir,
      reserved,
      candidates: [reserved, ...parseSavedLines(lastText)],
      snapshot,
      sinceMs: startMs
    });
    finals = results.map((file) => ({ path: file, source: matchSource(file, generated), inPlace: true }));
    for (const file of results) {
      ctx.filled.add(file);
    }
  }
  const saveErrors = [];
  if (finals.length === 0 && generated.length > 0) {
    const count = generated.length;
    const ext = path.extname(outTarget.path);
    const stem = outTarget.path.slice(0, outTarget.path.length - ext.length);
    const destinationFor = (index) => {
      // The skill-mode placeholder is reused for the first image when its name fits.
      if (index === 0 && reserved && (count === 1 || outTarget.kind === "dir")) {
        return reserved;
      }
      if (outTarget.kind === "file") {
        return reserveFor(ctx, count === 1 ? outTarget.path : `${stem}-${index + 1}${ext}`, force);
      }
      return reserveFor(ctx, path.join(outTarget.path, `${prefix}${index + 1}.png`), false);
    };
    generated.forEach((source, index) => {
      try {
        const destination = destinationFor(index);
        const written = materialize({ source, destination, size: job.size, warnings, ctx });
        ctx.filled.add(written);
        finals.push({ path: written, source, inPlace: false });
      } catch (error) {
        saveErrors.push(error.message);
        warnings.push(`could not save image ${index + 1} of ${count}: ${error.message}`);
      }
    });
  }

  if (finals.length === 0) {
    let reason;
    if (saveErrors.length > 0) {
      reason = `could not save the generated image: ${saveErrors[saveErrors.length - 1]}`;
    } else if (turn.timedOut) {
      reason = `codex timed out after ${Math.round(turn.timeoutMs / 1000)}s`;
    } else if (turn.state.failures.length > 0) {
      reason = `codex failed: ${turn.state.failures[turn.state.failures.length - 1].slice(0, 300)}`;
    } else if (turn.status !== 0) {
      reason = `codex exited with status ${turn.status} and produced no image`;
    } else {
      reason = "codex finished but produced no image";
    }
    return { ok: false, reason, stderrTail: turn.stderrTail, lines: [], saved: [], warnings };
  }
  if (turn.status !== 0 || turn.timedOut) {
    warnings.push(`codex exited with status ${turn.status}${turn.timedOut ? " (timed out)" : ""} but ${finals.length} image(s) were generated; saved them`);
  }

  const sips = hasSips();
  const lines = [];
  for (const final of finals) {
    claimedPaths.add(final.path);
    if (final.inPlace) {
      fixInPlaceFormat(final.path, warnings, ctx);
      if (job.size) {
        if (sips) {
          if (!applySize(final.path, job.size)) {
            warnings.push(`size not applied to ${final.path} (sips failed)`);
          }
        } else {
          warnings.push("size not applied (sips not available)");
        }
      }
    }
    lines.push(`SAVED: ${final.path}`);
    if (sips) {
      const info = sipsInfo(final.path);
      if (info) {
        lines.push(`INFO: ${final.path} ${info.width}x${info.height} alpha=${info.alpha ? "yes" : "no"}${final.source ? ` source=${final.source}` : ""}`);
      }
    }
  }
  const usage = turn.state.usage;
  const secs = Math.round((Date.now() - startMs) / 1000);
  const usageLine = `USAGE: mode=${settings.mode} model=${settings.model ?? "account-default"} effort=${settings.effort} secs=${secs} input=${usage.input} cached=${usage.cached} output=${usage.output} thread=${turn.state.threadId ?? "unknown"}`;
  return { ok: true, lines, saved: finals, usageLine, warnings, stderrTail: turn.stderrTail };
}

function reportFailure(result) {
  console.error(`Error: ${result.reason}`);
  if (result.stderrTail && result.stderrTail.trim()) {
    console.error(result.stderrTail.trim());
  }
}

async function handleImageCommand(kind, argv) {
  const cwd = process.cwd();
  let parsed;
  let job;
  try {
    // A real argv keeps one token per element; a single string is split by the tokenizer.
    parsed = kind === "edit" ? parseEditArguments(argv) : parseGenerateArguments(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!parsed.prompt || (kind === "edit" && !parsed.input)) {
    console.error(
      kind === "edit"
        ? "Usage: /codex-image:edit [flags] <input-path> <edit instructions>"
        : "Usage: /codex-image:generate [flags] [--ref <reference-image> ...] <natural-language image request>"
    );
    process.exitCode = 1;
    return;
  }
  try {
    resolveRunSettings(parsed);
    resolveOutTarget(parsed.out, cwd);
    job = {
      kind,
      prompt: parsed.prompt,
      out: parsed.out,
      size: parsed.size,
      transparent: parsed.transparent,
      mode: parsed.mode,
      effort: parsed.effort,
      model: parsed.model,
      force: parsed.force,
      cwd
    };
    if (kind === "edit") {
      job.inputPath = resolveExistingImagePaths([parsed.input], cwd, "Input")[0];
    } else {
      job.referenceImagePaths = resolveExistingImagePaths(parsed.referenceImages, cwd, "Reference");
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const result = await runImageJob(job);
  for (const warning of result.warnings ?? []) {
    console.error(`codex-image: warning: ${warning}`);
  }
  if (!result.ok) {
    reportFailure(result);
    process.exitCode = 1;
    return;
  }
  for (const line of result.lines) {
    console.log(line);
  }
  console.log(result.usageLine);
}

// ---------------------------------------------------------------------------
// batch
// ---------------------------------------------------------------------------

// Validate the whole manifest before anything is spawned. Relative paths resolve
// against the manifest's directory. Returns normalized jobs.
function parseBatchManifest(text, baseDir, exists = fs.existsSync) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Manifest must be a non-empty JSON array.");
  }
  if (data.length > MAX_BATCH_ITEMS) {
    throw new Error(`Manifest has ${data.length} items; the maximum is ${MAX_BATCH_ITEMS}.`);
  }
  const problems = [];
  const jobs = data.map((item, index) => {
    const n = index + 1;
    const fail = (message) => problems.push(`item ${n}: ${message}`);
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail("must be an object");
      return null;
    }
    const known = new Set(["prompt", "out", "refs", "edit", "size", "transparent", "force"]);
    for (const key of Object.keys(item)) {
      if (!known.has(key)) {
        fail(`unknown field "${key}"`);
      }
    }
    if (typeof item.prompt !== "string" || !item.prompt.trim()) {
      fail("prompt must be a non-empty string");
    }
    if (item.out !== undefined && (typeof item.out !== "string" || !item.out)) {
      fail("out must be a non-empty string");
    } else if (typeof item.out === "string") {
      try {
        resolveOutTarget(item.out, baseDir);
      } catch (error) {
        fail(error.message);
      }
    }
    for (const key of ["transparent", "force"]) {
      if (item[key] !== undefined && typeof item[key] !== "boolean") {
        fail(`${key} must be a boolean`);
      }
    }
    let size = null;
    if (item.size !== undefined) {
      try {
        size = parseSize(item.size);
      } catch (error) {
        fail(error.message);
      }
    }
    const referenceImagePaths = [];
    if (item.refs !== undefined) {
      if (!Array.isArray(item.refs) || item.refs.some((ref) => typeof ref !== "string" || !ref)) {
        fail("refs must be an array of paths");
      } else if (item.refs.length > MAX_REFERENCE_IMAGES) {
        fail(`at most ${MAX_REFERENCE_IMAGES} refs`);
      } else {
        for (const ref of item.refs) {
          const abs = resolveUserPath(baseDir, ref);
          if (!exists(abs)) {
            fail(`reference image not found: ${abs}`);
          }
          referenceImagePaths.push(abs);
        }
      }
    }
    let inputPath = null;
    if (item.edit !== undefined) {
      if (typeof item.edit !== "string" || !item.edit) {
        fail("edit must be an input image path");
      } else {
        inputPath = resolveUserPath(baseDir, item.edit);
        if (!exists(inputPath)) {
          fail(`input image not found: ${inputPath}`);
        }
        if (referenceImagePaths.length > 0) {
          fail("refs cannot be combined with edit");
        }
      }
    }
    return {
      kind: inputPath ? "edit" : "generate",
      prompt: typeof item.prompt === "string" ? item.prompt.trim() : "",
      out: typeof item.out === "string" ? resolveUserPath(baseDir, item.out) : null,
      referenceImagePaths,
      inputPath,
      size,
      transparent: item.transparent === true,
      force: item.force === true
    };
  });
  if (problems.length > 0) {
    throw new Error(`Invalid manifest:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  }
  return jobs;
}

async function handleBatch(argv) {
  let options;
  let jobs;
  let settingsCheck;
  try {
    options = parseBatchArguments(argv);
    if (!options.manifest) {
      throw new Error("Usage: /codex-image:batch <manifest.json> [--mode m] [--effort e] [--model s] [--parallel N]");
    }
    settingsCheck = resolveRunSettings(options);
    const manifestPath = resolveUserPath(process.cwd(), options.manifest);
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Manifest not found: ${manifestPath}`);
    }
    jobs = parseBatchManifest(fs.readFileSync(manifestPath, "utf8"), path.dirname(manifestPath));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const started = Date.now();
  const results = new Array(jobs.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length && !interruptedBy) {
      const index = next;
      next += 1;
      const job = {
        ...jobs[index],
        mode: options.mode,
        effort: options.effort,
        model: options.model,
        cwd: process.cwd(),
        label: String(index + 1)
      };
      let result;
      try {
        result = await runImageJob(job);
      } catch (error) {
        result = { ok: false, reason: error.message, lines: [], warnings: [] };
      }
      results[index] = result;
      for (const warning of result.warnings ?? []) {
        console.error(`codex-image: [${index + 1}] warning: ${warning}`);
      }
      if (result.ok) {
        for (const line of result.lines) {
          console.log(line);
        }
        console.log(`ITEM ${index + 1} ok`);
      } else {
        console.error(`codex-image: [${index + 1}] ${result.reason}`);
        if (result.stderrTail?.trim()) {
          console.error(result.stderrTail.trim());
        }
        console.log(`ITEM ${index + 1} failed ${result.reason}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.parallel, jobs.length) }, worker));
  const ok = results.filter((result) => result?.ok).length;
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`USAGE: batch items=${jobs.length} ok=${ok} secs=${secs} mode=${settingsCheck.mode} effort=${settingsCheck.effort}`);
  process.exitCode = ok === jobs.length ? 0 : ok === 0 ? 1 : 2;
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function parseStatusOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--cwd" || token.startsWith("--cwd=")) {
      const eq = token.indexOf("=");
      const value = eq === -1 ? argv[index + 1] : token.slice(eq + 1);
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --cwd.");
      }
      options.cwd = value;
      if (eq === -1) {
        index += 1;
      }
      continue;
    }
    if (token === "--help" || token === "-h" || token === "help") {
      options.help = true;
      continue;
    }
  }
  return options;
}

function resolveCwd(options) {
  return path.resolve(process.cwd(), options.cwd ?? ".");
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    stdio: "pipe",
    maxBuffer: options.maxBuffer,
    timeout: options.timeout,
    windowsHide: true
  });

  return {
    available: !(result.error && result.error.code === "ENOENT"),
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

function statusLine(ok, label, detail) {
  return `${ok ? "OK" : "FAIL"} ${label}: ${detail}`;
}

// clap rejects a flag with a multi-line usage blurb; keep a status row to its first line.
function firstLine(text) {
  return String(text ?? "").trim().split(/\r?\n/)[0] ?? "";
}

function findImagegenSkill(home) {
  const candidate = path.join(home, "skills", ".system", "imagegen", "SKILL.md");
  return fs.existsSync(candidate) ? candidate : null;
}

function buildStatusReport(options = {}) {
  const cwd = resolveCwd(options);
  const codex = getCodex();
  const home = resolveCodexHome();
  const childEnv = { ...process.env, CODEX_HOME: home.path };
  const nodeVersion = process.versions.node;
  const nodeVersionCompare = compareSemver(nodeVersion, MIN_NODE_VERSION);
  const nodeOk = nodeVersionCompare !== null && nodeVersionCompare >= 0;

  const codexVersion = runSync(codex.command, [...codex.prefix, "--version"], { cwd });
  const codexVersionText = (codexVersion.stdout || codexVersion.stderr).trim();
  const codexVersionCompare = compareSemver(codexVersionText, MIN_CODEX_VERSION);
  const codexOk = codexVersion.available && codexVersion.status === 0 && codexVersionCompare !== null && codexVersionCompare >= 0;

  // Login is checked against the resolved image home, since that is where the turn runs.
  const loginStatus = codexOk ? runSync(codex.command, [...codex.prefix, "login", "status"], { cwd, env: childEnv }) : null;
  const loginText = loginStatus ? (loginStatus.stdout || loginStatus.stderr).trim() : "Codex unavailable";
  const loginOk = Boolean(loginStatus?.status === 0 && /logged in/i.test(loginText));

  const headlessExecStatus = codexOk
    ? runSync(codex.command, [...codex.prefix, "exec", "--sandbox", "workspace-write", "--help"], { cwd })
    : null;
  const headlessExecOk = Boolean(headlessExecStatus?.status === 0);

  // Probed independently of the headless flag: a rejected flag makes clap print a short
  // usage error with no option list (#5).
  const execHelp = codexOk ? runSync(codex.command, [...codex.prefix, "exec", "--help"], { cwd }) : null;
  const execHelpText = `${execHelp?.stdout ?? ""}\n${execHelp?.stderr ?? ""}`;
  const imageAttachmentOk = Boolean(execHelp?.status === 0 && /(^|\s)(-i,\s*)?--image(\s|=|<|$)/.test(execHelpText));
  const jsonOk = Boolean(execHelp?.status === 0 && /--json\b/.test(execHelpText));

  const imagegenSkillPath = findImagegenSkill(home.path);
  const imagegenOk = Boolean(imagegenSkillPath);

  let defaults;
  let defaultsError = null;
  try {
    const settings = resolveRunSettings({});
    defaults = { mode: settings.mode, effort: settings.effort, model: settings.model ?? "account default" };
  } catch (error) {
    defaultsError = error.message;
    defaults = { mode: "direct", effort: DEFAULT_EFFORT.direct, model: "account default" };
  }
  const sips = hasSips();

  const loginKnown = codexOk;
  // The imagegen skill is only used in skill mode; direct mode does not need it.
  const ready = nodeOk && codexOk && loginOk && headlessExecOk && imageAttachmentOk && jsonOk && !defaultsError;
  const nextSteps = [];
  if (!nodeOk) {
    nextSteps.push(`Install Node.js ${MIN_NODE_VERSION} or newer.`);
  }
  if (!codexVersion.available) {
    nextSteps.push("Install Codex CLI with `npm install -g @openai/codex`.");
  } else if (!codexOk) {
    nextSteps.push(`Upgrade Codex CLI to ${MIN_CODEX_VERSION} or newer with \`npm install -g @openai/codex\`.`);
  }
  if (loginKnown && !loginOk) {
    nextSteps.push(`Run \`CODEX_HOME=${home.path} codex login\` (or link auth.json, see README).`);
  }
  if (codexOk && !headlessExecOk) {
    nextSteps.push("This plugin depends on `codex exec --sandbox workspace-write`; check `codex exec --help` for the current sandbox flag.");
  }
  if (codexOk && !imageAttachmentOk) {
    nextSteps.push("This plugin depends on `codex exec --image` for edit and reference-image input. Upgrade Codex CLI.");
  }
  if (codexOk && !jsonOk) {
    nextSteps.push("This plugin depends on `codex exec --json`. Upgrade Codex CLI.");
  }
  if (defaultsError) {
    nextSteps.push(`Fix the environment override: ${defaultsError}`);
  }

  const headlessExec = {
    ok: headlessExecOk,
    detail: headlessExecOk
      ? "`codex exec --sandbox workspace-write` accepted"
      : firstLine(headlessExecStatus?.stderr || headlessExecStatus?.stdout || "not checked")
  };

  return {
    ready,
    cwd,
    node: { ok: nodeOk, version: nodeVersion, minimum: MIN_NODE_VERSION },
    codex: {
      ok: codexOk,
      available: codexVersion.available,
      version: codexVersionText || codexVersion.error?.message || "not found",
      minimum: MIN_CODEX_VERSION
    },
    login: { ok: loginOk, detail: loginText || "not logged in" },
    headlessExec,
    jsonOutput: { ok: jsonOk, detail: jsonOk ? "`codex exec --json` accepted" : "not found in `codex exec --help`" },
    imageAttachment: {
      ok: imageAttachmentOk,
      detail: imageAttachmentOk
        ? "`codex exec --image` accepted"
        : "not found in `codex exec --help`"
    },
    home: { path: home.path, source: home.source, dedicated: home.dedicated },
    imagegenSkill: { ok: imagegenOk, path: imagegenSkillPath },
    defaults,
    sips: { ok: sips },
    nextSteps
  };
}

function renderStatusReport(report) {
  const lines = ["Codex Image status", "", `Ready: ${report.ready ? "yes" : "no"}`, ""];
  lines.push(statusLine(report.node.ok, "Node", `v${report.node.version} (minimum ${report.node.minimum})`));
  lines.push(statusLine(report.codex.ok, "Codex", `${report.codex.version} (minimum ${report.codex.minimum})`));
  lines.push(statusLine(report.login.ok, "Codex login", report.login.detail));
  lines.push(statusLine(report.headlessExec.ok, "Headless exec", report.headlessExec.detail));
  lines.push(statusLine(report.jsonOutput.ok, "JSON events", report.jsonOutput.detail));
  lines.push(statusLine(report.imageAttachment.ok, "Image attachment", report.imageAttachment.detail));
  lines.push(
    `INFO Image home: ${report.home.path} (${report.home.dedicated ? "dedicated ~/.codex-image" : `from ${report.home.source}, not the dedicated ~/.codex-image`})`
  );
  lines.push(`INFO imagegen skill (skill mode only): ${report.imagegenSkill.path ?? "not found under the image home"}`);
  lines.push(`INFO Defaults: mode=${report.defaults.mode} effort=${report.defaults.effort} model=${report.defaults.model}`);
  lines.push(`INFO sips (exact --size, format conversion, INFO lines): ${report.sips.ok ? "available" : "not available"}`);
  lines.push("");
  lines.push("Usage:");
  lines.push('  /codex-image:generate --out images/library.png --size 1024x1024 "A watercolor moonlit library"');
  lines.push('  /codex-image:generate --ref style.png --out images/poster.png "A poster using that style"');
  lines.push('  /codex-image:edit --out edited.png input.png "Replace the background with a clean white studio backdrop"');
  lines.push("  /codex-image:batch manifest.json --parallel 2");
  lines.push("");
  lines.push("Cost note: each image runs a Codex agent turn plus the built-in image generation tool (direct mode ~35 s, ~37k tokens).");

  if (report.nextSteps.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

function handleStatus(argv) {
  const options = parseStatusOptions(argv);
  if (options.help) {
    console.log("Usage: /codex-image:status");
    return;
  }
  const report = buildStatusReport(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderStatusReport(report));
  }
  if (!report.ready) {
    process.exitCode = 1;
  }
}

function usage() {
  return [
    "Usage: codex-image <command> [args]   (or: node scripts/codex-image.mjs <command> [args])",
    "",
    "Commands:",
    "  status [--json] [--cwd <dir>]                 Report Codex CLI prerequisites and image support",
    "  generate [flags] <request>                    Generate image(s)",
    "  edit [flags] <input-path> <edit instructions> Edit an image",
    "  batch <manifest.json> [--mode m] [--effort e] [--model s] [--parallel N]",
    "",
    "Flags (generate, edit; before the prompt, `--` ends flags):",
    "  --out <path>        file (.png/.jpg/.jpeg) or directory; default ./codex-images/",
    "  --size <W>x<H>      exact final size (cover + center-crop, needs sips on macOS)",
    "  --transparent       request a transparent background",
    "  --ref <path>        reference image (generate only, repeatable, max 5)",
    "  --mode direct|skill default direct (env CODEX_IMAGE_MODE)",
    "  --effort <e>        low|medium|high|xhigh|max|ultra (env CODEX_IMAGE_EFFORT)",
    "  --model <slug>      default: account default (env CODEX_IMAGE_MODEL)",
    "  --force             overwrite an existing --out file (default: -v2, -v3 ... sibling)",
    "",
    "Stdout: SAVED: <path>, INFO: <path> <W>x<H> alpha=<yes|no> source=<path>, USAGE: ...",
    "",
    "Each command is also exposed as a Claude Code plugin skill:",
    "  /codex-image:status",
    "  /codex-image:generate <...>",
    "  /codex-image:edit <...>",
    "  /codex-image:batch <manifest.json> [--parallel N]"
  ].join("\n");
}

// `--args-stdin`: the raw argument string comes from our own stdin (SKILL.md heredoc with a
// quoted delimiter, so the shell expands nothing). codex's stdin stays ignored.
function expandArgsStdin(rest) {
  if (!rest.includes("--args-stdin")) {
    return rest;
  }
  if (rest.length > 1) {
    throw new Error("--args-stdin cannot be combined with other arguments.");
  }
  let text = "";
  try {
    text = fs.readFileSync(0, "utf8");
  } catch {
    text = "";
  }
  return [text.replace(/\r?\n$/, "")];
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...restRaw] = argv;
  const rest = ["generate", "edit", "batch"].includes(command) ? expandArgsStdin(restRaw) : restRaw;
  if (["generate", "edit", "batch"].includes(command)) {
    installSignalHandlers();
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }

  // `setup` kept as backwards-compatible alias for the renamed `status` command.
  if (command === "status" || command === "setup") {
    handleStatus(rest);
    return;
  }

  if (command === "generate") {
    await handleImageCommand("generate", rest);
    return;
  }

  if (command === "edit") {
    await handleImageCommand("edit", rest);
    return;
  }

  if (command === "batch") {
    await handleBatch(rest);
    return;
  }

  throw new Error(`Unknown command "${command}".\n${usage()}`);
}

// Resolve symlinks (~/.local/bin/codex-image -> scripts/codex-image.mjs) before comparing.
// argv[1] is undefined when this module is imported from `node -e` / a REPL.
function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  });
}

export {
  CODEX_EXEC_BASE_ARGS,
  DEFAULT_EFFORT,
  MAX_REFERENCE_IMAGES,
  applyCodexEvent,
  buildCodexArgs,
  buildDirectEditInstruction,
  buildDirectGenerateInstruction,
  buildEditInstruction,
  buildGenerateInstruction,
  buildSkillEditInstruction,
  buildSkillGenerateInstruction,
  buildStatusReport,
  collectSkillResults,
  compareSemver,
  expandHome,
  createJsonlStreamer,
  createEventState,
  detectImageFormat,
  extractPromptAddDirs,
  getCodex,
  hasImageExtension,
  main,
  parseBatchArguments,
  parseBatchManifest,
  parseCodexJsonl,
  parseEditArguments,
  parseGenerateArguments,
  parseJsonLine,
  parseSavedLines,
  parseSemver,
  parseSize,
  planDestinations,
  renderStatusReport,
  reserveFile,
  resolveCodex,
  resolveCodexHome,
  resolveOutTarget,
  resolveRunSettings,
  runImageJob,
  splitFirstToken,
  timestampForFile,
  validateEffort,
  versionedPath
};
