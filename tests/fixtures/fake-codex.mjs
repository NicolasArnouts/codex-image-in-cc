#!/usr/bin/env node
// Hermetic stand-in for `codex exec` used by the end-to-end tests. Never touches the
// network. Behaviour is steered by env: FAKE_CODEX_FAIL=1 (exit 1, no image),
// FAKE_CODEX_IMAGES=<n> (default 1), FAKE_CODEX_LOG=<file> (append the argv as JSON).
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
if (process.env.FAKE_CODEX_NO_THREAD !== "1") {
  emit({ type: "thread.started", thread_id: thread });
}
console.log("not json: ignored by the wrapper");
emit({ type: "turn.started" });

if (process.env.FAKE_CODEX_FAIL === "1") {
  emit({ type: "turn.failed", error: { message: "fake codex failure" } });
  console.error("fake codex stderr: boom");
  process.exit(1);
}

const home = process.env.CODEX_HOME;
const dir = path.join(home, "generated_images", thread);
fs.mkdirSync(dir, { recursive: true });
const count = Number.parseInt(process.env.FAKE_CODEX_IMAGES ?? "1", 10);
for (let index = 1; index <= count; index += 1) {
  fs.writeFileSync(path.join(dir, `ig-${index}.png`), makePng());
}
emit({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "DONE" } });

const outIndex = args.indexOf("-o");
if (outIndex !== -1) {
  fs.writeFileSync(args[outIndex + 1], "DONE\n");
}
emit({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
