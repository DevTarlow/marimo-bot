#!/usr/bin/env node
/**
 * The live voice-input check.
 *
 * It is not in CI: the model is 158 MB, the runtime is native, and neither is a
 * thing to fetch on every push. What it proves is what no unit test can: that the
 * pinned int8 ONNX Runtime graphs load through the packaged CPU provider, that
 * the frontend's 80-sample framing and the merged decoder produce the expected
 * words, and what the first and warm transcriptions cost in time and peak RAM.
 *
 * Run it after `pnpm build`, with `MARIMO_MODEL_DIR` pointing at a model root
 * (or `--download` to fetch the pinned files first):
 *
 *   MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/live-model \
 *     node scripts/stt-check.mjs --download --long
 *
 * The 11-second fixture is a public-domain excerpt of President Kennedy's 1961
 * inaugural address, as distributed in whisper.cpp's samples directory. Its
 * SHA-256 is pinned; `--wav <path>` reads another 16 kHz mono PCM16 file.
 */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixturePath = join(root, 'scripts', 'fixtures', 'jfk.wav');
const FIXTURE_SHA =
  '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e';
const modelRoot =
  process.env.MARIMO_MODEL_DIR ?? join(root, '.marimo-stt-model');
const dir = join(modelRoot, 'listen', 'small');
const download = process.argv.includes('--download');
const long = process.argv.includes('--long');
const wavAt = process.argv.indexOf('--wav');
const wavPath = wavAt >= 0 ? process.argv[wavAt + 1] : undefined;

const runtime = await import(
  join(root, 'packages', 'runtime', 'dist', 'index.js')
).catch(() => {
  throw new Error('Run `pnpm build` first: packages/runtime/dist is missing.');
});
const {createOrtGraphs} = await import(
  join(root, 'apps', 'desktop', 'dist', 'main', 'listen-ort.js')
).catch(() => {
  throw new Error('Run `pnpm build` first: apps/desktop/dist is missing.');
});

if (!(await runtime.isListenInstalled(dir))) {
  if (!download) {
    console.error(
      `The voice-input model is not installed under ${dir}.\n` +
        'Run with --download, or point MARIMO_MODEL_DIR at a directory holding ' +
        'the pinned files under listen/small/.',
    );
    process.exit(1);
  }
  console.log(`Downloading the voice-input model into ${dir} ...`);
  let last = -1;
  await runtime.installListen({
    dir,
    onProgress: (progress) => {
      const percent = progress.percent ?? -1;
      if (percent < 0 || Math.floor(percent / 10) === last) {
        return;
      }
      last = Math.floor(percent / 10);
      console.log(`  ${progress.label}: ${String(Math.floor(percent))}%`);
    },
  });
}

const wav = await readFile(wavPath ?? fixturePath);
if (wavPath === undefined) {
  const digest = createHash('sha256').update(wav).digest('hex');
  if (digest !== FIXTURE_SHA) {
    throw new Error(
      `The JFK fixture's fingerprint is ${digest}, not ${FIXTURE_SHA}.`,
    );
  }
}
const audio = readWav(wav);
if (audio.sampleRate !== 16_000 || audio.channels !== 1 || audio.bits !== 16) {
  throw new Error(
    `The fixture is ${String(audio.sampleRate)} Hz, ${String(audio.channels)} ` +
      `channel(s), ${String(audio.bits)}-bit; this check needs 16 kHz mono PCM16.`,
  );
}

const assets = await runtime.readListenAssets(dir);
const totalBytes = runtime.LISTEN_TOTAL_BYTES;
console.log(
  `model: Moonshine Streaming Small, ${String(assets.config.depth)} layers, ` +
    `${String(totalBytes)} bytes, ${(audio.samples.length / 16_000).toFixed(2)} s fixture`,
);

const graphs = await createOrtGraphs(dir, assets.config);
const first = await transcribe(audio.samples);
assertWords(first.text, ['fellow americans', 'country'], 'the JFK fixture');
report('first (graphs load + transcribe)', first);

/*
 * The odd length is the padding check: the model frames at 80 samples, and a
 * clip that ends 37 samples past a frame has to be zero-padded rather than
 * losing its tail.
 */
const odd = audio.samples.subarray(0, audio.samples.length - 37);
const padded = await transcribe(odd);
assertWords(padded.text, ['fellow americans'], 'a clip that ends mid-frame');
report('padded clip', padded);

if (long) {
  const sixty = new Float32Array(16_000 * 61);
  for (let at = 0; at < sixty.length; at += audio.samples.length) {
    sixty.set(
      audio.samples.subarray(
        0,
        Math.min(audio.samples.length, sixty.length - at),
      ),
      at,
    );
  }
  const longResult = await transcribe(sixty);
  if (!longResult.truncated) {
    throw new Error('A 61-second clip was not reported as truncated.');
  }
  console.log(
    `60 s cap: ${(longResult.ms / 1000).toFixed(2)} s, ` +
      `${String(longResult.tokens.length)} tokens, text length ` +
      `${String(longResult.text.length)} (the model token cap may stop it early)`,
  );
  report('61 s input, capped at 60', longResult);
}

await graphs.release();
console.log(`peak RSS: ${String(peakMb())} MB`);

async function transcribe(pcm) {
  const started = Date.now();
  const result = await runtime.transcribePcm({
    pcm,
    sampleRate: 16_000,
    config: assets.config,
    tokenizer: assets.tokenizer,
    graphs,
    maxSeconds: 60,
  });
  return {...result, wallMs: Date.now() - started};
}

function report(label, result) {
  const seconds = result.durationSeconds;
  const rtf = result.wallMs / 1000 / Math.max(seconds, 0.001);
  console.log(
    `${label}: ${String(result.wallMs)} ms, ${seconds.toFixed(2)} s audio, ` +
      `RTF ${rtf.toFixed(3)}, ${String(result.tokens.length)} tokens, ` +
      `peak ${String(peakMb())} MB`,
  );
  console.log(`  ${result.text}`);
}

function assertWords(text, words, label) {
  const lower = text.toLowerCase();
  for (const word of words) {
    if (!lower.includes(word)) {
      throw new Error(`${label} did not transcribe "${word}": ${text}`);
    }
  }
}

function peakMb() {
  return Math.round(process.resourceUsage().maxRSS / 1024);
}

/** A 16 kHz mono PCM16 WAV, refusing anything else. */
function readWav(buffer) {
  let at = 12;
  let fmt;
  let data;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('latin1', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
      break;
    }
    at = body + size + (size % 2);
  }
  if (fmt === undefined || data === undefined) {
    throw new Error('The fixture has no fmt/data chunk.');
  }
  if (fmt.format !== 1) {
    throw new Error('The fixture is not PCM.');
  }
  const count = Math.floor(data.length / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32_768;
  }
  return {...fmt, samples};
}
