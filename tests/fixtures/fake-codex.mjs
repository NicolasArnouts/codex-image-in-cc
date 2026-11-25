#!/usr/bin/env node
// Hermetic stand-in for `codex exec` used by the end-to-end tests. Never touches the
// network. Behaviour is steered by env: FAKE_CODEX_FAIL=1 (exit 1, no image),
// FAKE_CODEX_IMAGES=<n> (default 1), FAKE_CODEX_LOG=<file> (append the argv as JSON),
// FAKE_CODEX_HANG=1 (after thread.started: spawn a grandchild, write "<pid> <grandchild
// pid>" to FAKE_CODEX_PID_FILE, then hang forever), FAKE_CODEX_IGNORE_TERM=1 (both
// ignore SIGTERM), FAKE_CODEX_FORMAT=png|jpeg|webp (bytes of the generated file; jpeg
// needs macOS sips), FAKE_CODEX_EXT=<.ext> (file extension, default from the format),
// FAKE_CODEX_UNREADABLE=1 (chmod 000 the generated files), FAKE_CODEX_NO_ROLLOUT=1 (no
// sessions/ rollout file), FAKE_CODEX_NO_THREAD=1 (no thread.started event).
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) {
  fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify(args)}\n`);
}
if (args[0] === "--version") {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

// Solid RGBA PNG, 4x4.
function makePng(size = 4) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 4, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// stdin trap: the wrapper must hand codex a closed/empty stdin (/dev/null), never a pipe.
const stdinStat = fs.fstatSync(0);
if (stdinStat.isFIFO() || stdinStat.isSocket() || stdinStat.isFile()) {
  console.error("fake codex: stdin is not /dev/null (stdin trap)");
  process.exit(3);
}
if (process.env.FAKE_CODEX_PROMPT_FILE) {
  fs.writeFileSync(process.env.FAKE_CODEX_PROMPT_FILE, args[args.length - 1]);
}
const delay = Number.parseInt(process.env.FAKE_CODEX_DELAY_MS ?? "0", 10);
if (delay > 0) {
  await new Promise((resolve) => setTimeout(resolve, delay));
}

const emit = (event) => console.log(JSON.stringify(event));
const thread = crypto.randomUUID();
const home = process.env.CODEX_HOME;
if (process.env.FAKE_CODEX_NO_ROLLOUT !== "1") {
  // Like codex: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl
  const now = new Date();
  const day = path.join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${thread}.jsonl`), "{}\n");
}
if (process.env.FAKE_CODEX_NO_THREAD !== "1") {
  emit({ type: "thread.started", thread_id: thread });
}
if (process.env.FAKE_CODEX_HANG === "1") {
  const ignore = process.env.FAKE_CODEX_IGNORE_TERM === "1";
  if (ignore) {
    process.on("SIGTERM", () => {});
  }
  const grandchild = spawn(process.execPath, ["-e", `${ignore ? "process.on('SIGTERM',()=>{});" : ""}setInterval(()=>{},1000)`], { stdio: "ignore" });
  if (process.env.FAKE_CODEX_PID_FILE) {
    // Written via a temp file + rename so a reader never sees a half-written line.
    const tmp = `${process.env.FAKE_CODEX_PID_FILE}.tmp`;
    fs.writeFileSync(tmp, `${process.pid} ${grandchild.pid}`);
    fs.renameSync(tmp, process.env.FAKE_CODEX_PID_FILE);
  }
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
console.log("not json: ignored by the wrapper");
emit({ type: "turn.started" });

if (process.env.FAKE_CODEX_FAIL === "1") {
  emit({ type: "turn.failed", error: { message: "fake codex failure" } });
  console.error("fake codex stderr: boom");
  process.exit(1);
}

const dir = path.join(home, "generated_images", thread);
const count = Number.parseInt(process.env.FAKE_CODEX_IMAGES ?? "1", 10);
if (count > 0) {
  fs.mkdirSync(dir, { recursive: true });
}
const format = process.env.FAKE_CODEX_FORMAT ?? "png";
const ext = process.env.FAKE_CODEX_EXT ?? { png: ".png", jpeg: ".jpg", webp: ".webp" }[format];
for (let index = 1; index <= count; index += 1) {
  const file = path.join(dir, `ig-${index}${ext}`);
  if (format === "jpeg") {
    const png = path.join(dir, `.src-${index}.png`);
    fs.writeFileSync(png, makePng());
    spawnSync("sips", ["-s", "format", "jpeg", png, "--out", file], { stdio: "ignore" });
    fs.rmSync(png);
  } else if (format === "webp") {
    // RIFF....WEBP header: enough for magic-byte detection, not a decodable image.
    fs.writeFileSync(file, Buffer.concat([Buffer.from("RIFF"), Buffer.from([26, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(14)]));
  } else {
    fs.writeFileSync(file, makePng());
  }
  if (process.env.FAKE_CODEX_UNREADABLE === "1") {
    fs.chmodSync(file, 0o000);
  }
}
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "DONE" } });

const outIndex = args.indexOf("-o");
if (outIndex !== -1) {
  fs.writeFileSync(args[outIndex + 1], "DONE\n");
}
emit({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
