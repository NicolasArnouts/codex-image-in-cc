import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODEX_EXEC_BASE_ARGS,
  buildCodexArgs,
  buildDirectEditInstruction,
  buildDirectGenerateInstruction,
  buildGenerateInstruction,
  buildSkillEditInstruction,
  buildSkillGenerateInstruction,
  collectSkillResults,
  compareSemver,
  expandHome,
  extractPromptAddDirs,
  parseBatchArguments,
  parseBatchManifest,
  parseCodexJsonl,
  parseEditArguments,
  parseGenerateArguments,
  parseSavedLines,
  createJsonlStreamer,
  createEventState,
  planDestinations,
  reserveFile,
  resolveCodex,
  resolveCodexHome,
  resolveOutTarget,
  resolveRunSettings,
  splitFirstToken,
  timestampForFile,
  versionedPath
} from "../scripts/codex-image.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "scripts", "codex-image.mjs");
const FAKE_CODEX = path.join(here, "fixtures", "fake-codex.mjs");
const isMac = process.platform === "darwin";

// ---------------------------------------------------------------------------
// Small helpers kept from earlier versions
// ---------------------------------------------------------------------------

test("compareSemver handles prefixed command output", () => {
  assert.equal(compareSemver("codex-cli 0.124.0", "0.124.0"), 0);
  assert.equal(compareSemver("v20.10.0", "18.18.0"), 1);
  assert.equal(compareSemver("0.123.9", "0.124.0"), -1);
});

test("timestampForFile is filesystem-safe", () => {
  assert.equal(timestampForFile(new Date("2026-04-24T13:04:05Z")), "20260424-130405Z");
});

test("splitFirstToken splits unquoted path from prompt", () => {
  assert.deepEqual(splitFirstToken("photo.png make it red"), { input: "photo.png", prompt: "make it red" });
});

test("splitFirstToken supports double- and single-quoted paths with spaces", () => {
  assert.deepEqual(splitFirstToken('"my photo.png" tint blue'), { input: "my photo.png", prompt: "tint blue" });
  assert.deepEqual(splitFirstToken("'a b.png' brighten"), { input: "a b.png", prompt: "brighten" });
});

test("splitFirstToken returns nulls for empty input and input-only when prompt is missing", () => {
  assert.deepEqual(splitFirstToken("  "), { input: null, prompt: null });
  assert.deepEqual(splitFirstToken("only.png"), { input: "only.png", prompt: "" });
});

test("resolveCodex uses the bare codex command outside Windows", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(resolveCodex(), { command: "codex", prefix: [] });
});

// ---------------------------------------------------------------------------
// Flag parsing (guards: leading flags never leak into the prompt, prompt never lost)
// ---------------------------------------------------------------------------

test("parseGenerateArguments returns the prompt untouched when there are no flags", () => {
  const parsed = parseGenerateArguments("A calm lake at dawn");
  assert.equal(parsed.prompt, "A calm lake at dawn");
  assert.deepEqual(parsed.referenceImages, []);
  assert.equal(parsed.out, null);
  assert.equal(parsed.transparent, false);
  assert.equal(parsed.force, false);
});

test("parseGenerateArguments parses every flag in space form", () => {
  const parsed = parseGenerateArguments(
    "--ref a.png --reference b.png --image c.png --out out/hero.png --size 1200x630 --transparent --mode skill --effort high --model gpt-x --force A hero"
  );
  assert.deepEqual(parsed.referenceImages, ["a.png", "b.png", "c.png"]);
  assert.equal(parsed.out, "out/hero.png");
  assert.deepEqual(parsed.size, { width: 1200, height: 630 });
  assert.equal(parsed.transparent, true);
  assert.equal(parsed.mode, "skill");
  assert.equal(parsed.effort, "high");
  assert.equal(parsed.model, "gpt-x");
  assert.equal(parsed.force, true);
  assert.equal(parsed.prompt, "A hero");
});

test("parseGenerateArguments accepts --flag=value forms", () => {
  const parsed = parseGenerateArguments("--ref=a.png --out=x/y.webp --size=64X32 --mode=direct --effort=LOW --model=m draw it");
  assert.deepEqual(parsed.referenceImages, ["a.png"]);
  assert.equal(parsed.out, "x/y.webp");
  assert.deepEqual(parsed.size, { width: 64, height: 32 });
  assert.equal(parsed.effort, "low");
  assert.equal(parsed.prompt, "draw it");
});

test("parseGenerateArguments supports quoted paths with spaces", () => {
  const parsed = parseGenerateArguments('--ref "my ref.png" --out "out dir/a b.png" A cat');
  assert.deepEqual(parsed.referenceImages, ["my ref.png"]);
  assert.equal(parsed.out, "out dir/a b.png");
  assert.equal(parsed.prompt, "A cat");
});

test("parseGenerateArguments: `--` ends flags so a flag-like prompt survives", () => {
  const parsed = parseGenerateArguments("--out a.png -- --force is the prompt");
  assert.equal(parsed.out, "a.png");
  assert.equal(parsed.force, false);
  assert.equal(parsed.prompt, "--force is the prompt");
});

test("parseGenerateArguments treats an unknown --flag as the start of the prompt", () => {
  const parsed = parseGenerateArguments("--out a.png --weird thing here");
  assert.equal(parsed.prompt, "--weird thing here");
});

test("parseGenerateArguments rejects missing values, bad size, bad effort, bad mode", () => {
  assert.throws(() => parseGenerateArguments("--ref"), /Missing value for --ref/);
  assert.throws(() => parseGenerateArguments("--out --force x"), /Missing value for --out/);
  assert.throws(() => parseGenerateArguments("--size 0x10 x"), /Invalid size/);
  assert.throws(() => parseGenerateArguments("--size 9000x10 x"), /Invalid size/);
  assert.throws(() => parseGenerateArguments("--size big x"), /Invalid size/);
  assert.throws(() => parseGenerateArguments("--effort minimal x"), /minimal/);
  assert.throws(() => parseGenerateArguments("--effort none x"), /none/);
  assert.throws(() => parseGenerateArguments("--mode fast x"), /Invalid --mode/);
});

test("parseGenerateArguments rejects more than five reference images", () => {
  const flags = Array.from({ length: 6 }, (_, i) => `--ref r${i}.png`).join(" ");
  assert.throws(() => parseGenerateArguments(`${flags} prompt`), /Too many reference images/);
});

test("parseEditArguments: flags first, then input path, then the prompt (quoted path ok)", () => {
  const parsed = parseEditArguments('--out e.png --force "my photo.png" make it red');
  assert.equal(parsed.out, "e.png");
  assert.equal(parsed.force, true);
  assert.equal(parsed.input, "my photo.png");
  assert.equal(parsed.prompt, "make it red");
  const plain = parseEditArguments("photo.png tint blue");
  assert.equal(plain.input, "photo.png");
  assert.equal(plain.prompt, "tint blue");
});

test("parseEditArguments does not take --ref as a reference flag", () => {
  const parsed = parseEditArguments("--ref x.png y.png");
  assert.deepEqual(parsed.referenceImages, []);
  assert.equal(parsed.input, "--ref");
});

// ---------------------------------------------------------------------------
// Settings and home resolution
// ---------------------------------------------------------------------------

test("resolveRunSettings: flag beats env beats mode default; model is optional", () => {
  assert.deepEqual(resolveRunSettings({}, {}), { mode: "direct", effort: "low", model: null });
  assert.deepEqual(resolveRunSettings({ mode: "skill" }, {}), { mode: "skill", effort: "medium", model: null });
  assert.deepEqual(resolveRunSettings({}, { CODEX_IMAGE_MODE: "skill", CODEX_IMAGE_EFFORT: "high", CODEX_IMAGE_MODEL: "m1" }), {
    mode: "skill",
    effort: "high",
    model: "m1"
  });
  assert.deepEqual(resolveRunSettings({ effort: "max", model: "m2" }, { CODEX_IMAGE_EFFORT: "high", CODEX_IMAGE_MODEL: "m1" }), {
    mode: "direct",
    effort: "max",
    model: "m2"
  });
});

test("resolveRunSettings: effort and model are independent (no both-required rule) and bad env fails", () => {
  assert.equal(resolveRunSettings({}, { CODEX_IMAGE_MODEL: "only-model" }).effort, "low");
  assert.equal(resolveRunSettings({}, { CODEX_IMAGE_EFFORT: "ultra" }).model, null);
  assert.throws(() => resolveRunSettings({}, { CODEX_IMAGE_EFFORT: "minimal" }), /CODEX_IMAGE_EFFORT/);
  assert.throws(() => resolveRunSettings({}, { CODEX_IMAGE_MODE: "x" }), /CODEX_IMAGE_MODE/);
});

test("resolveCodexHome precedence: CODEX_IMAGE_HOME > ~/.codex-image > CODEX_HOME > ~/.codex", () => {
  const homedir = "/home/u";
  const yes = () => true;
  const no = () => false;
  assert.equal(resolveCodexHome({ env: { CODEX_IMAGE_HOME: "/x", CODEX_HOME: "/y" }, homedir, exists: yes }).path, "/x");
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: "/y" }, homedir, exists: yes }).path, "/home/u/.codex-image");
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: "/y" }, homedir, exists: yes }).dedicated, true);
  assert.equal(resolveCodexHome({ env: { CODEX_HOME: "/y" }, homedir, exists: no }).path, "/y");
  assert.equal(resolveCodexHome({ env: {}, homedir, exists: no }).path, "/home/u/.codex");
});

// ---------------------------------------------------------------------------
// Out-path planning (guards: never overwrite silently, naming contract)
// ---------------------------------------------------------------------------

test("resolveOutTarget: image extension (any case) is a file, otherwise a directory, default ./codex-images", () => {
  assert.deepEqual(resolveOutTarget("a/hero.PNG", "/w"), { kind: "file", path: "/w/a/hero.PNG", dir: "/w/a" });
  assert.equal(resolveOutTarget("a/b.jpeg", "/w").kind, "file");
  assert.throws(() => resolveOutTarget("a/b.webp", "/w"), /webp/);
  assert.throws(() => resolveOutTarget("a/b.gif", "/w"), /Unsupported --out extension "\.gif"/);
  assert.throws(() => resolveOutTarget("a/b.tiff", "/w"), /Unsupported/);
  assert.deepEqual(resolveOutTarget("a/logos", "/w"), { kind: "dir", path: "/w/a/logos", dir: "/w/a/logos" });
  assert.deepEqual(resolveOutTarget(undefined, "/w"), { kind: "dir", path: "/w/codex-images", dir: "/w/codex-images" });
  assert.equal(resolveOutTarget("/abs/x.png", "/w").path, "/abs/x.png");
});

test("versionedPath returns hero-v2, hero-v3 ... when the file exists", () => {
  const taken = new Set(["/o/hero.png", "/o/hero-v2.png"]);
  const exists = (file) => taken.has(file);
  assert.equal(versionedPath("/o/new.png", exists), "/o/new.png");
  assert.equal(versionedPath("/o/hero.png", exists), "/o/hero-v3.png");
});

test("planDestinations: single file, multi-image naming, force, directory defaults", () => {
  const file = { kind: "file", path: "/o/hero.png", dir: "/o" };
  const none = () => false;
  assert.deepEqual(planDestinations({ target: file, count: 1, exists: none }), ["/o/hero.png"]);
  assert.deepEqual(planDestinations({ target: file, count: 3, exists: none }), ["/o/hero-1.png", "/o/hero-2.png", "/o/hero-3.png"]);
  const taken = new Set(["/o/hero.png", "/o/hero-2.png"]);
  const exists = (f) => taken.has(f);
  assert.deepEqual(planDestinations({ target: file, count: 1, exists }), ["/o/hero-v2.png"]);
  assert.deepEqual(planDestinations({ target: file, count: 2, exists }), ["/o/hero-1.png", "/o/hero-2-v2.png"]);
  assert.deepEqual(planDestinations({ target: file, count: 1, exists, force: true }), ["/o/hero.png"]);
  const dir = { kind: "dir", path: "/o/d", dir: "/o/d" };
  assert.deepEqual(planDestinations({ target: dir, count: 2, timestamp: "T", exists: none }), ["/o/d/T-1.png", "/o/d/T-2.png"]);
  assert.deepEqual(planDestinations({ target: dir, count: 1, timestamp: "T", edit: true, exists: none }), ["/o/d/T-edit-1.png"]);
});

// ---------------------------------------------------------------------------
// Instructions and codex args
// ---------------------------------------------------------------------------

test("direct generate instruction: no file ops, prompt unchanged, DONE contract, refs, size, transparency", () => {
  const text = buildDirectGenerateInstruction({
    prompt: "a red fox",
    referenceImagePaths: ["/r/a.png", "/r/b.png"],
    transparent: true,
    size: { width: 1200, height: 630 }
  });
  assert.match(text, /image_gen\.imagegen/);
  assert.match(text, /do not run shell commands/);
  assert.match(text, /Set transparent_background to true\./);
  assert.match(text, /referenced_image_paths:\n\/r\/a\.png\n\/r\/b\.png/);
  assert.match(text, /1200x630/);
  assert.match(text, /exactly one line: DONE\./);
  assert.ok(text.endsWith("Request:\n\na red fox"));
  const plain = buildDirectGenerateInstruction({ prompt: "x" });
  assert.match(plain, /only if the request asks for transparency/);
  assert.doesNotMatch(plain, /referenced_image_paths:/);
});

test("direct edit instruction names the absolute input and labels the request", () => {
  const text = buildDirectEditInstruction({ inputPath: "/i/photo.png", prompt: "make it red" });
  assert.match(text, /Edit the image at \/i\/photo\.png/);
  assert.match(text, /Preserve everything the request does not ask to change/);
  assert.ok(text.endsWith("Edit request:\n\nmake it red"));
});

test("skill instructions keep the imagegen skill prefix and add the SAVED contract with the resolved out path", () => {
  const fileTarget = { kind: "file", path: "/o/hero.png", dir: "/o" };
  const gen = buildSkillGenerateInstruction({ prompt: "p", referenceImagePaths: ["/r/a.png"], outTarget: fileTarget, transparent: true, size: { width: 8, height: 4 } });
  assert.match(gen, /^Use the imagegen skill\./);
  assert.match(gen, /Save the final image to exactly \/o\/hero\.png \(an empty placeholder/);
  assert.match(gen, /Never overwrite any other existing file/);
  assert.match(gen, /\/o\/hero-2\.png/);
  assert.match(gen, /SAVED: <absolute path>/);
  assert.match(gen, /transparent background/);
  assert.match(gen, /8x4/);
  assert.match(gen, /1\. \/r\/a\.png/);
  const edit = buildSkillEditInstruction({ inputPath: "/i/x.png", prompt: "e", outTarget: { kind: "dir", path: "/o/d", dir: "/o/d" } });
  assert.match(edit, /^Use the imagegen skill\./);
  assert.match(edit, /\/i\/x\.png/);
  assert.match(edit, /Save the final image\(s\) into \/o\/d: the first as exactly \/o\/d\/<UTC-timestamp>-edit-1\.png/);
  assert.match(edit, /User edit request:\n\ne$/);
});

test("buildGenerateInstruction dispatches on mode", () => {
  assert.match(buildGenerateInstruction({ mode: "direct", prompt: "p" }), /^Generate the image/);
  assert.match(buildGenerateInstruction({ mode: "skill", prompt: "p", outTarget: { kind: "dir", path: "/o", dir: "/o" } }), /^Use the imagegen skill/);
});

test("buildCodexArgs: --json, --add-dir, -o, effort -c, no -m without model, -m with model, never --full-auto", () => {
  const args = buildCodexArgs({
    cwd: "/w",
    effort: "low",
    addDirs: ["/o", "/o"],
    lastMessageFile: "/t/last.txt",
    images: ["/i/a.png"],
    instruction: "do it"
  });
  assert.ok(args.includes("--json"));
  assert.equal(args[0], "exec");
  assert.ok(args.includes("--skip-git-repo-check"));
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.equal(args[args.indexOf("--add-dir") + 1], "/o");
  assert.equal(args.filter((a) => a === "--add-dir").length, 1, "add-dir deduplicated");
  assert.equal(args[args.indexOf("-o") + 1], "/t/last.txt");
  assert.equal(args[args.indexOf("--image") + 1], "/i/a.png");
  assert.equal(args[args.indexOf("-C") + 1], "/w");
  assert.ok(!args.includes("-m"));
  assert.ok(!args.includes("--full-auto"));
  assert.deepEqual(args.slice(-2), ["--", "do it"]);
  assert.ok(buildCodexArgs({ cwd: "/w", effort: "high", model: "gpt-x", instruction: "i" }).join(" ").includes("-m gpt-x"));
  assert.ok(!CODEX_EXEC_BASE_ARGS.includes("--full-auto"));
});

test("extractPromptAddDirs: nearest existing ancestor of absolute image paths, deduped, never /", () => {
  const existing = new Set(["/", "/Users", "/Users/k", "/Users/k/refs"]);
  const exists = (d) => existing.has(d);
  const prompt = "mix /Users/k/refs/a.png and /Users/k/refs/b.JPG with /Users/k/new/deep/c.webp and /nope/d.png, relative x.png";
  assert.deepEqual(extractPromptAddDirs(prompt, exists).sort(), ["/Users/k", "/Users/k/refs"]);
  assert.deepEqual(extractPromptAddDirs("no paths here", exists), []);
});

// ---------------------------------------------------------------------------
// JSONL parser against real Codex output
// ---------------------------------------------------------------------------

test("parseCodexJsonl reads the real direct-mode fixture (thread, messages, usage, deduped warnings)", () => {
  const state = parseCodexJsonl(fs.readFileSync(path.join(here, "fixtures", "direct-low.jsonl"), "utf8"));
  assert.equal(state.threadId, "01a2125a-befc-7660-bac0-260fa341315d");
  assert.deepEqual(state.messages, ["I’ll pass your prompt unchanged to the image generation tool.", "DONE"]);
  assert.deepEqual(state.usage, { input: 37079, cached: 23808, output: 93 });
  assert.equal(state.warnings.length, 1, "identical non-fatal errors are deduped");
  assert.deepEqual(state.failures, []);
});

test("parseCodexJsonl reads the real skill-mode fixture and exposes SAVED lines", () => {
  const state = parseCodexJsonl(fs.readFileSync(path.join(here, "fixtures", "skill-medium.jsonl"), "utf8"));
  assert.equal(state.threadId, "01a2125b-46bf-7391-8ae1-c875a9b6f181");
  assert.deepEqual(state.usage, { input: 84665, cached: 61568, output: 506 });
  assert.deepEqual(parseSavedLines(state.messages.join("\n")), ["/tmp/fixture/skill-medium.png"]);
});

test("parseCodexJsonl ignores non-JSON lines and records turn.failed / top-level error events", () => {
  const text = [
    "warning: plain text",
    "{ broken json",
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"error","message":"stream died"}',
    '{"type":"turn.failed","error":{"message":"model not supported"}}'
  ].join("\n");
  const state = parseCodexJsonl(text);
  assert.equal(state.threadId, "t1");
  assert.deepEqual(state.failures, ["stream died", "model not supported"]);
});

// ---------------------------------------------------------------------------
// Batch manifest / arguments
// ---------------------------------------------------------------------------

test("parseBatchManifest normalizes items, resolves paths against the manifest dir, and picks the kind", () => {
  const jobs = parseBatchManifest(
    JSON.stringify([
      { prompt: " one ", out: "out/a.png", size: "64x32", transparent: true },
      { prompt: "two", edit: "in.png", force: true },
      { prompt: "three", refs: ["r.png"] }
    ]),
    "/m",
    () => true
  );
  assert.equal(jobs[0].kind, "generate");
  assert.equal(jobs[0].prompt, "one");
  assert.equal(jobs[0].out, "/m/out/a.png");
  assert.deepEqual(jobs[0].size, { width: 64, height: 32 });
  assert.equal(jobs[1].kind, "edit");
  assert.equal(jobs[1].inputPath, "/m/in.png");
  assert.equal(jobs[1].force, true);
  assert.deepEqual(jobs[2].referenceImagePaths, ["/m/r.png"]);
});

test("parseBatchManifest rejects the whole manifest before anything runs", () => {
  const yes = () => true;
  assert.throws(() => parseBatchManifest("nope", "/m", yes), /not valid JSON/);
  assert.throws(() => parseBatchManifest("{}", "/m", yes), /non-empty JSON array/);
  assert.throws(() => parseBatchManifest("[]", "/m", yes), /non-empty JSON array/);
  const tooMany = JSON.stringify(Array.from({ length: 21 }, () => ({ prompt: "x" })));
  assert.throws(() => parseBatchManifest(tooMany, "/m", yes), /maximum is 20/);
  assert.throws(() => parseBatchManifest(JSON.stringify([{ prompt: "ok" }, { prompt: "" }]), "/m", yes), /item 2: prompt/);
  assert.throws(() => parseBatchManifest(JSON.stringify([{ prompt: "x", size: "huge" }]), "/m", yes), /item 1: Invalid size/);
  assert.throws(() => parseBatchManifest(JSON.stringify([{ prompt: "x", edit: "i.png", refs: ["r.png"] }]), "/m", yes), /refs cannot be combined with edit/);
  assert.throws(() => parseBatchManifest(JSON.stringify([{ prompt: "x", bogus: 1 }]), "/m", yes), /unknown field "bogus"/);
  assert.throws(() => parseBatchManifest(JSON.stringify([{ prompt: "x", refs: ["r.png"] }]), "/m", () => false), /reference image not found/);
});

test("parseBatchArguments parses manifest, flags, and bounds --parallel", () => {
  const options = parseBatchArguments('"my m.json" --parallel 2 --mode skill --effort=high --model x');
  assert.equal(options.manifest, "my m.json");
  assert.equal(options.parallel, 2);
  assert.equal(options.mode, "skill");
  assert.equal(options.effort, "high");
  assert.equal(options.model, "x");
  assert.equal(parseBatchArguments("m.json").parallel, 1);
  assert.throws(() => parseBatchArguments("m.json --parallel 4"), /Invalid --parallel/);
  assert.throws(() => parseBatchArguments("m.json --parallel 0"), /Invalid --parallel/);
  assert.throws(() => parseBatchArguments("m.json --wat 1"), /Unknown batch option/);
});

// ---------------------------------------------------------------------------
// Hermetic end-to-end tests with a fake codex (no real codex, no network)
// ---------------------------------------------------------------------------

function makeSandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-image-test-")));
  const home = path.join(dir, "home");
  fs.mkdirSync(home);
  return { dir, home, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function runCli(sandbox, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: sandbox.dir,
      env: {
        ...process.env,
        CODEX_IMAGE_CODEX_BIN: FAKE_CODEX,
        CODEX_IMAGE_HOME: sandbox.home,
        CODEX_IMAGE_MODE: "",
        CODEX_IMAGE_EFFORT: "",
        CODEX_IMAGE_MODEL: "",
        ...extraEnv
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const savedPaths = (stdout) => [...stdout.matchAll(/^SAVED: (.+)$/gm)].map((m) => m[1]);

test("e2e generate --out file: SAVED path exists, USAGE line present, stdout holds only contract lines", async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, "img", "hero.png");
    const log = path.join(sb.dir, "args.log");
    const result = await runCli(sb, ["generate", "--out", out, "a fox"], { FAKE_CODEX_LOG: log });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(savedPaths(result.stdout), [out]);
    assert.ok(fs.existsSync(out));
    assert.ok(fs.readFileSync(out).subarray(1, 4).toString() === "PNG");
    assert.match(result.stdout, /^USAGE: mode=direct model=account-default effort=low secs=\d+ input=100 cached=40 output=7 thread=[0-9a-f-]+$/m);
    for (const line of result.stdout.trim().split("\n")) {
      assert.match(line, /^(SAVED|INFO|USAGE): /, `unexpected stdout line: ${line}`);
    }
    assert.match(result.stderr, /codex-image: thread .* started/);
    assert.match(result.stderr, /codex-image: codex: DONE/);
    const argv = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]);
    assert.ok(argv.includes("--json") && !argv.includes("-m") && !argv.includes("--full-auto"));
    assert.equal(argv[argv.indexOf("--add-dir") + 1], path.dirname(out));
  } finally {
    sb.cleanup();
  }
});

test("e2e second run without --force writes a -v2 sibling, --force overwrites", async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, "hero.png");
    const first = await runCli(sb, ["generate", "--out", out, "x"]);
    assert.deepEqual(savedPaths(first.stdout), [out]);
    const second = await runCli(sb, ["generate", "--out", out, "x"]);
    assert.deepEqual(savedPaths(second.stdout), [path.join(sb.dir, "hero-v2.png")]);
    assert.ok(fs.existsSync(path.join(sb.dir, "hero-v2.png")));
    const forced = await runCli(sb, ["generate", "--out", out, "--force", "x"]);
    assert.deepEqual(savedPaths(forced.stdout), [out]);
    assert.ok(!fs.existsSync(path.join(sb.dir, "hero-v3.png")));
  } finally {
    sb.cleanup();
  }
});

test("e2e default out is ./codex-images/<timestamp>-<n>.png and multiple images get numbered", async () => {
  const sb = makeSandbox();
  try {
    const result = await runCli(sb, ["generate", "three variants"], { FAKE_CODEX_IMAGES: "3" });
    assert.equal(result.status, 0, result.stderr);
    const saved = savedPaths(result.stdout);
    assert.equal(saved.length, 3);
    saved.forEach((file, i) => {
      assert.equal(path.dirname(fs.realpathSync(file)), fs.realpathSync(path.join(sb.dir, "codex-images")));
      assert.match(path.basename(file), new RegExp(`^\\d{8}-\\d{6}Z-${i + 1}\\.png$`));
    });
  } finally {
    sb.cleanup();
  }
});

test("e2e edit: input must exist, edit instruction reaches codex with --image, edit naming applies", async () => {
  const sb = makeSandbox();
  try {
    const missing = await runCli(sb, ["edit", "nope.png", "make it blue"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Input image not found/);

    const input = path.join(sb.dir, "in.png");
    fs.writeFileSync(input, "x");
    const log = path.join(sb.dir, "args.log");
    const result = await runCli(sb, ["edit", "in.png", "make it blue"], { FAKE_CODEX_LOG: log });
    assert.equal(result.status, 0, result.stderr);
    const [saved] = savedPaths(result.stdout);
    assert.match(path.basename(saved), /^\d{8}-\d{6}Z-edit-1\.png$/);
    const argv = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]);
    assert.equal(fs.realpathSync(argv[argv.indexOf("--image") + 1]), fs.realpathSync(input));
    assert.match(argv[argv.length - 1], /Edit request:\n\nmake it blue$/);
  } finally {
    sb.cleanup();
  }
});

test("e2e skill mode with a fake codex that saves nothing falls back to the generated file", async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, "skill.png");
    const log = path.join(sb.dir, "args.log");
    const result = await runCli(sb, ["generate", "--mode", "skill", "--out", out, "p"], { FAKE_CODEX_LOG: log });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(savedPaths(result.stdout), [out]);
    assert.match(result.stdout, /USAGE: mode=skill model=account-default effort=medium/);
    const argv = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]);
    assert.ok(argv.includes('model_reasoning_effort="medium"'));
    assert.match(argv[argv.length - 1], /^Use the imagegen skill/);
  } finally {
    sb.cleanup();
  }
});

test("e2e --model and --effort reach codex; invalid effort exits 1 before spawning", async () => {
  const sb = makeSandbox();
  try {
    const log = path.join(sb.dir, "args.log");
    const ok = await runCli(sb, ["generate", "--model", "gpt-x", "--effort", "high", "--out", path.join(sb.dir, "m.png"), "p"], { FAKE_CODEX_LOG: log });
    assert.equal(ok.status, 0, ok.stderr);
    const argv = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]);
    assert.equal(argv[argv.indexOf("-m") + 1], "gpt-x");
    assert.ok(argv.includes('model_reasoning_effort="high"'));
    const bad = await runCli(sb, ["generate", "--effort", "minimal", "p"], { FAKE_CODEX_LOG: log });
    assert.equal(bad.status, 1);
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "codex was not spawned for the bad effort");
  } finally {
    sb.cleanup();
  }
});

test("e2e batch of 2 with --parallel 2 saves both and reports ITEM lines and a USAGE summary", async () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(
      path.join(sb.dir, "manifest.json"),
      JSON.stringify([
        { prompt: "one", out: "b/one.png" },
        { prompt: "two", out: "b/two.png" }
      ])
    );
    const result = await runCli(sb, ["batch", "manifest.json", "--parallel", "2"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(savedPaths(result.stdout).length, 2);
    assert.ok(fs.existsSync(path.join(sb.dir, "b", "one.png")));
    assert.ok(fs.existsSync(path.join(sb.dir, "b", "two.png")));
    assert.match(result.stdout, /^ITEM 1 ok$/m);
    assert.match(result.stdout, /^ITEM 2 ok$/m);
    assert.match(result.stdout, /^USAGE: batch items=2 ok=2 secs=\d+/m);
  } finally {
    sb.cleanup();
  }
});

test("e2e batch: invalid manifest exits 1 before spawning; all-failed exits 1", async () => {
  const sb = makeSandbox();
  try {
    const log = path.join(sb.dir, "args.log");
    fs.writeFileSync(path.join(sb.dir, "bad.json"), JSON.stringify([{ prompt: "ok" }, { prompt: 5 }]));
    const bad = await runCli(sb, ["batch", "bad.json"], { FAKE_CODEX_LOG: log });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /item 2: prompt/);
    assert.ok(!fs.existsSync(log), "nothing was spawned");
    fs.writeFileSync(path.join(sb.dir, "m.json"), JSON.stringify([{ prompt: "a" }]));
    const failed = await runCli(sb, ["batch", "m.json"], { FAKE_CODEX_FAIL: "1" });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /^ITEM 1 failed /m);
  } finally {
    sb.cleanup();
  }
});

test("e2e fake codex exiting 1 with no image: exit 1, one-line reason and the stderr tail on stderr, nothing on stdout", async () => {
  const sb = makeSandbox();
  try {
    const result = await runCli(sb, ["generate", "--out", path.join(sb.dir, "x.png"), "p"], { FAKE_CODEX_FAIL: "1" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error: codex failed: fake codex failure/);
    assert.match(result.stderr, /fake codex stderr: boom/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "x.png")));
  } finally {
    sb.cleanup();
  }
});

test("e2e hard timeout kills a hung codex and fails (CODEX_IMAGE_TIMEOUT_MS)", { skip: process.platform === "win32" }, async () => {
  const sb = makeSandbox();
  try {
    const hang = path.join(sb.dir, "hang-codex.mjs");
    fs.writeFileSync(hang, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
    fs.chmodSync(hang, 0o755);
    const result = await runCli(sb, ["generate", "p"], { CODEX_IMAGE_CODEX_BIN: hang, CODEX_IMAGE_TIMEOUT_MS: "300" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /timed out/);
  } finally {
    sb.cleanup();
  }
});

test("e2e --size 2x2 on macOS: INFO line reports 2x2; non-png out converts or warns", { skip: !isMac }, async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, "small.png");
    const result = await runCli(sb, ["generate", "--out", out, "--size", "2x2", "p"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^INFO: ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} 2x2 alpha=(yes|no) source=.+generated_images.+\\.png$`, "m"));
    const wide = await runCli(sb, ["generate", "--out", path.join(sb.dir, "wide.png"), "--size", "8x2", "p"]);
    assert.match(wide.stdout, / 8x2 alpha=/);
    const jpg = await runCli(sb, ["generate", "--out", path.join(sb.dir, "j.jpg"), "p"]);
    assert.equal(jpg.status, 0, jpg.stderr);
    const [saved] = savedPaths(jpg.stdout);
    assert.equal(path.extname(saved), ".jpg");
    assert.deepEqual([...fs.readFileSync(saved).subarray(0, 3)], [0xff, 0xd8, 0xff], "JPEG magic bytes");
  } finally {
    sb.cleanup();
  }
});

test("main guard runs through a symlink (bin install) and prints usage", { skip: process.platform === "win32" }, async () => {
  const sb = makeSandbox();
  try {
    const link = path.join(sb.dir, "codex-image");
    fs.symlinkSync(SCRIPT, link);
    const output = await new Promise((resolve) => {
      const child = spawn(process.execPath, [link, "--help"], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", () => resolve(stdout));
    });
    assert.match(output, /Usage: codex-image <command>/);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review fixes: quoting, collisions, trust, tokenizer, process handling
// ---------------------------------------------------------------------------

function runCliStdin(sandbox, args, stdinText, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: sandbox.dir,
      env: {
        ...process.env,
        CODEX_IMAGE_CODEX_BIN: FAKE_CODEX,
        CODEX_IMAGE_HOME: sandbox.home,
        CODEX_IMAGE_MODE: "",
        CODEX_IMAGE_EFFORT: "",
        CODEX_IMAGE_MODEL: "",
        ...extraEnv
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdinText);
  });
}

test("argv with several elements keeps one token per element (spaced --out, spaced ref, prompt joined)", () => {
  const parsed = parseGenerateArguments(["--out", "/a b/x.png", "--ref", "/r s/ref.png", "a", "cat"]);
  assert.equal(parsed.out, "/a b/x.png");
  assert.deepEqual(parsed.referenceImages, ["/r s/ref.png"]);
  assert.equal(parsed.prompt, "a cat");
  const edit = parseEditArguments(["--out", "/o p/e.png", "/in put/photo.png", "make", "it", "red"]);
  assert.equal(edit.input, "/in put/photo.png");
  assert.equal(edit.prompt, "make it red");
  assert.equal(parseGenerateArguments(["--", "--force", "x"]).prompt, "--force x");
  assert.deepEqual(parseBatchArguments(["/m d/manifest.json", "--parallel", "2"]).manifest, "/m d/manifest.json");
});

test("tokenizer unescapes \\\" and \\' inside quotes and supports quoted inline values", () => {
  assert.deepEqual(splitFirstToken('"a \\"b\\" c.png" rest'), { input: 'a "b" c.png', prompt: "rest" });
  assert.deepEqual(splitFirstToken("'it\\'s.png' rest"), { input: "it's.png", prompt: "rest" });
  const parsed = parseGenerateArguments('--ref="/a b.png" --out="/o p/x.png" prompt here');
  assert.deepEqual(parsed.referenceImages, ["/a b.png"]);
  assert.equal(parsed.out, "/o p/x.png");
  assert.equal(parsed.prompt, "prompt here");
});

test("e2e real argv with a spaced --out saves to that exact path (argv.join used to split it)", async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, "a b", "x.png");
    const result = await runCli(sb, ["generate", "--out", out, "a", "cat"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(savedPaths(result.stdout), [out]);
    assert.ok(!fs.existsSync(path.join(sb.dir, "a")), "no stray split directory");
  } finally {
    sb.cleanup();
  }
});

test("e2e batch with a manifest in a spaced directory", async () => {
  const sb = makeSandbox();
  try {
    const dir = path.join(sb.dir, "my manifests");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "m f.json"), JSON.stringify([{ prompt: "one", out: "o u/one.png" }]));
    const result = await runCli(sb, ["batch", path.join(dir, "m f.json")]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(savedPaths(result.stdout), [path.join(dir, "o u", "one.png")]);
  } finally {
    sb.cleanup();
  }
});

test("e2e --args-stdin: $HOME, backticks and quotes in the prompt arrive literally; quoted spaced --out works", async () => {
  const sb = makeSandbox();
  try {
    const promptFile = path.join(sb.dir, "prompt.txt");
    const out = path.join(sb.dir, "sp ace", "y.png");
    const text = `--out '${out}' a $HOME \`x\` "q" $(touch ${path.join(sb.dir, "pwned")})\n`;
    const result = await runCliStdin(sb, ["generate", "--args-stdin"], text, { FAKE_CODEX_PROMPT_FILE: promptFile });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(savedPaths(result.stdout), [out]);
    const received = fs.readFileSync(promptFile, "utf8");
    assert.ok(received.endsWith(`Request:\n\na $HOME \`x\` "q" $(touch ${path.join(sb.dir, "pwned")})`), received);
    assert.ok(!fs.existsSync(path.join(sb.dir, "pwned")));
    const mixed = await runCliStdin(sb, ["generate", "--args-stdin", "extra"], "x");
    assert.equal(mixed.status, 1);
  } finally {
    sb.cleanup();
  }
});

test("reserveFile creates unique placeholders atomically (O_EXCL) and honors force", () => {
  const sb = makeSandbox();
  try {
    const file = path.join(sb.dir, "n", "x.png");
    const first = reserveFile(file);
    const second = reserveFile(file);
    const third = reserveFile(file);
    assert.deepEqual([first, second, third], [file, path.join(sb.dir, "n", "x-v2.png"), path.join(sb.dir, "n", "x-v3.png")]);
    assert.ok([first, second, third].every((f) => fs.existsSync(f)));
    assert.equal(reserveFile(file, { force: true }), file);
  } finally {
    sb.cleanup();
  }
});

test("e2e batch --parallel 2 with two items on the same out file yields two different files", async () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.dir, "m.json"), JSON.stringify([{ prompt: "a", out: "same.png" }, { prompt: "b", out: "same.png" }]));
    const result = await runCli(sb, ["batch", "m.json", "--parallel", "2"], { FAKE_CODEX_DELAY_MS: "300" });
    assert.equal(result.status, 0, result.stderr);
    const saved = savedPaths(result.stdout).sort();
    assert.deepEqual(saved, [path.join(sb.dir, "same-v2.png"), path.join(sb.dir, "same.png")]);
    assert.ok(saved.every((f) => fs.statSync(f).size > 0));
  } finally {
    sb.cleanup();
  }
});

test("e2e batch --parallel 2 with two items on the same dir (and default dir) yields distinct files", async () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.dir, "m.json"), JSON.stringify([{ prompt: "a", out: "d" }, { prompt: "b", out: "d" }, { prompt: "c" }, { prompt: "d" }]));
    const result = await runCli(sb, ["batch", "m.json", "--parallel", "3"], { FAKE_CODEX_DELAY_MS: "300" });
    assert.equal(result.status, 0, result.stderr);
    const saved = savedPaths(result.stdout);
    assert.equal(saved.length, 4);
    assert.equal(new Set(saved).size, 4, "all SAVED paths distinct");
    assert.ok(saved.every((f) => fs.statSync(f).size > 0));
  } finally {
    sb.cleanup();
  }
});

test("e2e a failed item leaves no placeholder and removes a directory the wrapper created", async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, "fresh", "deeper");
    const result = await runCli(sb, ["generate", "--out", out, "p"], { FAKE_CODEX_FAIL: "1" });
    assert.equal(result.status, 1);
    assert.ok(!fs.existsSync(path.join(sb.dir, "fresh")), "created dirs removed");
    fs.mkdirSync(path.join(sb.dir, "keep"));
    const file = path.join(sb.dir, "keep", "f.png");
    await runCli(sb, ["generate", "--out", file, "p"], { FAKE_CODEX_FAIL: "1" });
    assert.ok(!fs.existsSync(file), "empty placeholder removed");
    assert.ok(fs.existsSync(path.join(sb.dir, "keep")), "pre-existing dir kept");
  } finally {
    sb.cleanup();
  }
});

test("skill-mode trust: pre-existing files, files outside the out dir, empty files and non-images are rejected", () => {
  const sb = makeSandbox();
  try {
    const outDir = path.join(sb.dir, "out");
    fs.mkdirSync(outDir);
    const old = path.join(outDir, "old.png");
    fs.writeFileSync(old, "x");
    const snapshot = new Set([old]);
    const fresh = path.join(outDir, "fresh.png");
    const empty = path.join(outDir, "empty.png");
    const text = path.join(outDir, "notes.txt");
    const outside = path.join(sb.dir, "outside.png");
    const reserved = path.join(outDir, "res.png");
    for (const f of [fresh, text, outside]) {
      fs.writeFileSync(f, "data");
    }
    fs.writeFileSync(empty, "");
    fs.writeFileSync(reserved, "data");
    const got = collectSkillResults({
      outDir,
      reserved,
      candidates: [old, fresh, empty, text, outside, "/etc/hosts.png", reserved, fresh],
      snapshot: new Set([...snapshot, reserved]),
      sinceMs: Date.now() - 1000
    });
    assert.deepEqual(got.sort(), [fresh, reserved].sort());
  } finally {
    sb.cleanup();
  }
});

test("--out with an unsupported extension is rejected before spawning (.webp, .gif)", async () => {
  const sb = makeSandbox();
  try {
    const log = path.join(sb.dir, "args.log");
    for (const name of ["x.webp", "x.gif", "x.tiff"]) {
      const result = await runCli(sb, ["generate", "--out", path.join(sb.dir, name), "p"], { FAKE_CODEX_LOG: log });
      assert.equal(result.status, 1, name);
      assert.match(result.stderr, /Unsupported --out extension/);
    }
    assert.ok(!fs.existsSync(log));
    fs.writeFileSync(path.join(sb.dir, "m.json"), JSON.stringify([{ prompt: "x", out: "a.gif" }]));
    const batch = await runCli(sb, ["batch", "m.json"], { FAKE_CODEX_LOG: log });
    assert.equal(batch.status, 1);
    assert.ok(!fs.existsSync(log));
  } finally {
    sb.cleanup();
  }
});

test("--transparent with a .jpg out warns that alpha is dropped", async () => {
  const sb = makeSandbox();
  try {
    const result = await runCli(sb, ["generate", "--transparent", "--out", path.join(sb.dir, "t.jpg"), "p"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: --transparent with a \.jpg\/\.jpeg out/);
  } finally {
    sb.cleanup();
  }
});

test("missing thread id: only an unclaimed dir created after spawn is used; stale dirs are ignored", async () => {
  const sb = makeSandbox();
  try {
    const stale = path.join(sb.home, "generated_images", "stale-thread");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, "old.png"), "old");
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(stale, past, past);
    fs.utimesSync(path.join(stale, "old.png"), past, past);
    const out = path.join(sb.dir, "n.png");
    const result = await runCli(sb, ["generate", "--out", out, "p"], { FAKE_CODEX_NO_THREAD: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(fs.readFileSync(out, "utf8"), "old");
    assert.ok(fs.readFileSync(out).subarray(1, 4).toString() === "PNG");
  } finally {
    sb.cleanup();
  }
});

test("missing thread id in a parallel batch is ambiguous: items fail instead of stealing each other's images", async () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.dir, "m.json"), JSON.stringify([{ prompt: "a", out: "a.png" }, { prompt: "b", out: "b.png" }]));
    const result = await runCli(sb, ["batch", "m.json", "--parallel", "2"], { FAKE_CODEX_NO_THREAD: "1", FAKE_CODEX_DELAY_MS: "300" });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /ITEM 1 failed .*unambiguously/);
    assert.match(result.stdout, /ITEM 2 failed .*unambiguously/);
    assert.ok(!fs.existsSync(path.join(sb.dir, "a.png")) && !fs.existsSync(path.join(sb.dir, "b.png")));
  } finally {
    sb.cleanup();
  }
});

test("createJsonlStreamer reassembles a JSON line split across stdout chunks", () => {
  const state = createEventState();
  const progress = [];
  const streamer = createJsonlStreamer(state, (m) => progress.push(m));
  const line = '{"type":"thread.started","thread_id":"abc-123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}';
  streamer.feed(line.slice(0, 20));
  streamer.feed(line.slice(20, 70));
  streamer.feed(`${line.slice(70)}\nnot json\n{"type":"turn.compl`);
  streamer.feed('eted","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":2}}');
  streamer.end();
  assert.equal(state.threadId, "abc-123");
  assert.deepEqual(state.messages, ["hello"]);
  assert.deepEqual(state.usage, { input: 5, cached: 1, output: 2 });
  assert.ok(progress.includes("thread abc-123 started"));
});

test("e2e the stdin trap: codex gets /dev/null as stdin (fake codex exits 3 if it is a pipe)", async () => {
  const sb = makeSandbox();
  try {
    const result = await runCliStdin(sb, ["generate", "--out", path.join(sb.dir, "s.png"), "p"], "");
    assert.equal(result.status, 0, result.stderr);
  } finally {
    sb.cleanup();
  }
});

async function waitFor(condition, ms, label) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${ms} ms waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Wait until every recorded pid is gone (a zombie still answers kill 0 until reaped).
async function assertAllDead(pids) {
  await waitFor(() => pids.every((pid) => !isAlive(pid)), 3000, `pids ${pids.join(",")} to die`).catch(() => {});
  for (const pid of pids) {
    assert.ok(!isAlive(pid), `process ${pid} must be dead`);
  }
}

// Safety net: SIGKILL pids the fake codex recorded (processes this test spawned).
function killRecorded(pids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function readPids(pidFile) {
  return fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split(" ").map(Number).filter(Boolean) : [];
}

test("e2e timeout escalates to SIGKILL when codex ignores SIGTERM and kills its process group", { skip: process.platform === "win32" }, async () => {
  const sb = makeSandbox();
  const pidFile = path.join(sb.dir, "pids.txt");
  try {
    const started = Date.now();
    // The timeout is generous so the stub has always started and written its pids
    // before the wrapper gives up (a 400 ms timeout raced node startup: ENOENT).
    const result = await runCli(sb, ["generate", "p"], {
      FAKE_CODEX_HANG: "1",
      FAKE_CODEX_IGNORE_TERM: "1",
      FAKE_CODEX_PID_FILE: pidFile,
      CODEX_IMAGE_TIMEOUT_MS: "2500",
      CODEX_IMAGE_KILL_GRACE_MS: "300"
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /timed out/);
    assert.ok(Date.now() - started < 15000);
    const pids = readPids(pidFile);
    assert.equal(pids.length, 2, "the stub recorded its pid and its grandchild's pid");
    await assertAllDead(pids);
  } finally {
    killRecorded(readPids(pidFile));
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review round 3: quoting, home expansion, signals, cleanup, formats, attribution
// ---------------------------------------------------------------------------

test("an unterminated quote in a flag value, edit input or batch token is an error, not a literal folder", () => {
  assert.throws(() => parseGenerateArguments('--out "unterminated a cat'), /Unterminated quote/);
  assert.throws(() => parseGenerateArguments("--out='half a cat"), /Unterminated quote/);
  assert.throws(() => parseEditArguments('"in put.png make it red'), /Unterminated quote/);
  assert.throws(() => parseBatchArguments('"m f.json --parallel 2'), /Unterminated quote/);
  // A prompt that merely starts with an apostrophe is still a prompt.
  assert.equal(parseGenerateArguments("'tis a cat").prompt, "'tis a cat");
  // A real argv keeps quote characters literally (the shell already handled quoting).
  assert.equal(parseGenerateArguments(["--out", '"odd.png', "x"]).out, '"odd.png');
});

test("e2e an unterminated quoted --out exits 1 and creates nothing", async () => {
  const sb = makeSandbox();
  try {
    const result = await runCliStdin(sb, ["generate", "--args-stdin"], '--out "unterminated a cat');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unterminated quote/);
    assert.deepEqual(fs.readdirSync(sb.dir).sort(), ["home"]);
  } finally {
    sb.cleanup();
  }
});

test("a leading ~/ or bare ~ expands to the home dir for --out, refs, edit input and manifest paths", () => {
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("~/a/b.png", "/h"), path.join("/h", "a", "b.png"));
  assert.equal(expandHome("~user/x.png", "/h"), "~user/x.png");
  assert.equal(expandHome("a/~/b", "/h"), "a/~/b");
  assert.equal(resolveOutTarget("~/x.png", "/somewhere").path, path.join(os.homedir(), "x.png"));
  assert.equal(resolveOutTarget("~", "/somewhere").path, os.homedir());
  const sb = makeSandbox();
  try {
    const jobs = parseBatchManifest(JSON.stringify([{ prompt: "p", out: "~/o.png" }]), sb.dir, () => true);
    assert.equal(jobs[0].out, path.join(os.homedir(), "o.png"));
  } finally {
    sb.cleanup();
  }
});

test("e2e --out ~/x.png and --ref ~/r.png resolve against HOME, no literal ./~ folder", { skip: process.platform === "win32" }, async () => {
  const sb = makeSandbox();
  try {
    const fakeHome = path.join(sb.dir, "fakehome");
    fs.mkdirSync(fakeHome);
    fs.writeFileSync(path.join(fakeHome, "r.png"), "ref");
    const work = path.join(sb.dir, "work");
    fs.mkdirSync(work);
    const result = await runCli({ ...sb, dir: work }, ["generate", "--out", "~/x.png", "--ref", "~/r.png", "p"], { HOME: fakeHome });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(savedPaths(result.stdout), [path.join(fakeHome, "x.png")]);
    assert.ok(!fs.existsSync(path.join(work, "~")), "no literal ~ folder");
  } finally {
    sb.cleanup();
  }
});

function spawnCli(sandbox, args, extraEnv = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    cwd: sandbox.dir,
    env: {
      ...process.env,
      CODEX_IMAGE_CODEX_BIN: FAKE_CODEX,
      CODEX_IMAGE_HOME: sandbox.home,
      CODEX_IMAGE_MODE: "",
      CODEX_IMAGE_EFFORT: "",
      CODEX_IMAGE_MODEL: "",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve) => child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr })));
  return { child, done };
}

for (const [signal, code, mode, ignoreTerm] of [
  ["SIGINT", 130, "direct", false],
  ["SIGTERM", 143, "direct", false],
  ["SIGHUP", 129, "direct", false],
  ["SIGINT", 130, "skill", true]
]) {
  test(`e2e ${signal} to the wrapper (${mode} mode${ignoreTerm ? ", codex ignores SIGTERM" : ""}) kills codex's process group, leaves no files, exits ${code}`, { skip: process.platform === "win32" }, async () => {
    const sb = makeSandbox();
    const pidFile = path.join(sb.dir, "pids.txt");
    const tmp = path.join(sb.dir, "tmp");
    fs.mkdirSync(tmp);
    try {
      const outDir = path.join(sb.dir, "out", "nested");
      const { child, done } = spawnCli(sb, ["generate", "--mode", mode, "--out", path.join(outDir, "hero.png"), "p"], {
        FAKE_CODEX_HANG: "1",
        FAKE_CODEX_IGNORE_TERM: ignoreTerm ? "1" : "",
        FAKE_CODEX_PID_FILE: pidFile,
        CODEX_IMAGE_KILL_GRACE_MS: "500",
        TMPDIR: tmp
      });
      await waitFor(() => fs.existsSync(pidFile), 10000, "the fake codex pid file");
      if (mode === "direct") {
        assert.ok(!fs.existsSync(path.join(outDir, "hero.png")), "direct mode reserves no placeholder during the turn");
      } else {
        assert.equal(fs.statSync(path.join(outDir, "hero.png")).size, 0, "skill mode reserved its placeholder up front");
      }
      child.kill(signal);
      const result = await done;
      assert.equal(result.status, code, `exit code (signal=${result.signal}) stderr: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${signal} received`));
      await assertAllDead(readPids(pidFile));
      assert.ok(!fs.existsSync(path.join(sb.dir, "out")), "placeholder, temp files and created dirs removed");
      assert.deepEqual(fs.readdirSync(tmp), [], "temp dir removed");
    } finally {
      killRecorded(readPids(pidFile));
      sb.cleanup();
    }
  });
}

test("e2e SIGINT in a pre-existing out dir removes only the placeholder and keeps the dir and other files", { skip: process.platform === "win32" }, async () => {
  const sb = makeSandbox();
  const pidFile = path.join(sb.dir, "pids.txt");
  try {
    const keep = path.join(sb.dir, "keep.png");
    fs.writeFileSync(keep, "mine");
    const { child, done } = spawnCli(sb, ["generate", "--mode", "skill", "--out", path.join(sb.dir, "keep.png"), "p"], {
      FAKE_CODEX_HANG: "1",
      FAKE_CODEX_PID_FILE: pidFile
    });
    await waitFor(() => fs.existsSync(pidFile), 10000, "the fake codex pid file");
    assert.ok(fs.existsSync(path.join(sb.dir, "keep-v2.png")));
    child.kill("SIGINT");
    const result = await done;
    assert.equal(result.status, 130);
    assert.ok(!fs.existsSync(path.join(sb.dir, "keep-v2.png")));
    assert.equal(fs.readFileSync(keep, "utf8"), "mine");
  } finally {
    killRecorded(readPids(pidFile));
    sb.cleanup();
  }
});

test("e2e a failure while finalizing (EACCES on the generated files) leaves no placeholder behind", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const sb = makeSandbox();
  try {
    const outDir = path.join(sb.dir, "keep");
    fs.mkdirSync(outDir);
    const result = await runCli(sb, ["generate", "--out", path.join(outDir, "x.png"), "p"], { FAKE_CODEX_IMAGES: "2", FAKE_CODEX_UNREADABLE: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not save the generated image: .*EACCES/);
    assert.deepEqual(fs.readdirSync(outDir), [], "no 0-byte x-1.png / x-2.png and no temp file");
    const fresh = path.join(sb.dir, "fresh");
    const again = await runCli(sb, ["generate", "--mode", "skill", "--out", fresh, "p"], { FAKE_CODEX_UNREADABLE: "1" });
    assert.equal(again.status, 1);
    assert.ok(!fs.existsSync(fresh), "skill placeholder and the created dir removed");
  } finally {
    sb.cleanup();
  }
});

test("e2e a long --out basename does not overflow NAME_MAX through the temp-file prefix", async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, `${"a".repeat(240)}.png`);
    const result = await runCli(sb, ["generate", "--out", out, "p"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(savedPaths(result.stdout), [out]);
    assert.ok(fs.statSync(out).size > 0);
  } finally {
    sb.cleanup();
  }
});

test("e2e source format is detected by magic bytes: jpeg data (even named .png) becomes a real png", { skip: !isMac }, async () => {
  const sb = makeSandbox();
  try {
    for (const ext of [".jpg", ".png"]) {
      const out = path.join(sb.dir, `from-jpeg${ext.replace(".", "-")}.png`);
      const result = await runCli(sb, ["generate", "--out", out, "p"], { FAKE_CODEX_FORMAT: "jpeg", FAKE_CODEX_EXT: ext });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual([...fs.readFileSync(out).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `PNG magic for a jpeg source named ${ext}`);
    }
  } finally {
    sb.cleanup();
  }
});

test("e2e a format mismatch without sips fails that image clearly and leaves no placeholder", async () => {
  const sb = makeSandbox();
  try {
    const cases = [
      { env: { FAKE_CODEX_FORMAT: "webp" }, out: "w.png", source: "webp" },
      { env: {}, out: "p.jpg", source: "png" }
    ];
    for (const item of cases) {
      const out = path.join(sb.dir, item.out);
      const result = await runCli(sb, ["generate", "--out", out, "p"], { ...item.env, CODEX_IMAGE_DISABLE_SIPS: "1" });
      assert.equal(result.status, 1, item.out);
      assert.match(result.stderr, new RegExp(`is ${item.source} but .* needs .*sips`));
      assert.ok(!fs.existsSync(out));
    }
    assert.deepEqual(fs.readdirSync(sb.dir).sort(), ["home"], "no kept-png fallback, no temp file");
  } finally {
    sb.cleanup();
  }
});

test("e2e --force with a directory target never overwrites: timestamp names stay versioned", async () => {
  const sb = makeSandbox();
  try {
    const dir = path.join(sb.dir, "d");
    fs.mkdirSync(dir);
    // Occupy the timestamp names this run can pick (now .. now+3 s).
    const now = Date.now();
    const occupied = [0, 1, 2, 3].map((s) => path.join(dir, `${timestampForFile(new Date(now + s * 1000))}-1.png`));
    for (const file of occupied) {
      fs.writeFileSync(file, "keep");
    }
    const result = await runCli(sb, ["generate", "--force", "--out", dir, "p"]);
    assert.equal(result.status, 0, result.stderr);
    for (const file of occupied) {
      assert.equal(fs.readFileSync(file, "utf8"), "keep", `${file} was overwritten`);
    }
    const [saved] = savedPaths(result.stdout);
    assert.match(path.basename(saved), /^\d{8}-\d{6}Z-1-v2\.png$/);
  } finally {
    sb.cleanup();
  }
});

test("missing thread id: an orphan thread dir created just before the spawn is never claimed", async () => {
  const sb = makeSandbox();
  try {
    const orphan = path.join(sb.home, "generated_images", "orphan-thread");
    fs.mkdirSync(orphan, { recursive: true });
    fs.copyFileSync(FAKE_CODEX, path.join(orphan, "fake.png"));
    const out = path.join(sb.dir, "o.png");
    const result = await runCli(sb, ["generate", "--out", out, "p"], { FAKE_CODEX_NO_THREAD: "1", FAKE_CODEX_IMAGES: "0" });
    assert.equal(result.status, 1, result.stdout);
    assert.ok(!fs.existsSync(out), "the orphan's image was not taken");
    assert.ok(fs.existsSync(path.join(orphan, "fake.png")));
  } finally {
    sb.cleanup();
  }
});

test("missing thread id and no session rollout created after the spawn: fail and leave the image where it is", async () => {
  const sb = makeSandbox();
  try {
    const out = path.join(sb.dir, "n.png");
    const result = await runCli(sb, ["generate", "--out", out, "p"], { FAKE_CODEX_NO_THREAD: "1", FAKE_CODEX_NO_ROLLOUT: "1" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no thread id from codex.*left in .*generated_images/);
    assert.ok(!fs.existsSync(out));
    const dirs = fs.readdirSync(path.join(sb.home, "generated_images"));
    assert.equal(dirs.length, 1);
    assert.equal(fs.readdirSync(path.join(sb.home, "generated_images", dirs[0])).length, 1, "image left in place");
  } finally {
    sb.cleanup();
  }
});
