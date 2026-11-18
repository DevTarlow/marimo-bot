#!/usr/bin/env node
/**
 * The voice model's live check.
 *
 * It is not in CI: it needs the five pinned files (about 92 MB) and the native
 * ONNX runtime, and downloading those on every push is not a thing CI should do.
 * What it proves is the part no unit test can: that the pinned graph loads, that
 * the English front end and the normaliser produce tokens the graph accepts, and
 * that the trimmed, faded, joined waveform is a real 24 kHz WAV with sound in it.
 *
 * Run it after `pnpm build`, with `MARIMO_MODEL_DIR` pointing at a directory that
 * holds `tts/` (or `--download` to fetch the pinned files first):
 *
 *   MARIMO_MODEL_DIR=$PWD/apps/desktop/.model-cache/live-model \
 *     node scripts/tts-check.mjs
 */
import {createRequire} from 'node:module';
import {readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modelRoot =
  process.env.MARIMO_MODEL_DIR ?? join(root, '.marimo-tts-model');
const dir = join(modelRoot, 'tts');
const download = process.argv.includes('--download');
const out = join(modelRoot, 'tts-check.wav');

const runtime = await import(
  join(root, 'packages', 'runtime', 'dist', 'index.js')
);
const require = createRequire(join(root, 'apps', 'desktop', 'package.json'));
const ort = require('onnxruntime-node');

if (!(await runtime.isSpeechInstalled(dir))) {
  if (!download) {
    console.error(
      `The voice model is not installed under ${dir}.\n` +
        'Run with --download, or point MARIMO_MODEL_DIR at a directory holding ' +
        'the five pinned files under tts/.',
    );
    process.exit(1);
  }
  console.log(`Downloading the voice model into ${dir} ...`);
  let last = -1;
  await runtime.installSpeech({
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

const catalogue = await runtime.readVoiceCatalogue(dir);
const packs = await runtime.readVoicePacks(dir);
const voice = runtime.resolveVoice(catalogue.voices, 'eleanor');
const pack = runtime.voicePack(packs, voice);
const vocab = JSON.parse(await readFile(join(dir, 'vocab.json'), 'utf8'));
const cmu = JSON.parse(await readFile(join(dir, 'cmu_misaki_us.json'), 'utf8'));
const phonemize = await runtime.createPhonemizer({vocab, cmu});

const loaded = Date.now();
const session = await ort.InferenceSession.create(
  join(dir, 'kitten_tts_2_mini.onnx'),
  {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  },
);
console.log(`session loaded in ${String(Date.now() - loaded)} ms`);

const speechSession = {
  async run({inputIds, style, speed}) {
    const outputs = await session.run({
      input_ids: new ort.Tensor('int64', inputIds, [1, inputIds.length]),
      style: new ort.Tensor('float32', style, [1, style.length]),
      speed: new ort.Tensor('float32', Float32Array.from([speed]), [1]),
    });
    return {
      waveform: outputs[session.outputNames[0]].data,
      durations: outputs[session.outputNames[1]].data,
    };
  },
};

async function render(text, speed = 1) {
  const started = Date.now();
  const result = await runtime.synthesize({
    text,
    vocab,
    voicePack: pack,
    session: speechSession,
    phonemize,
    sampleRate: catalogue.sampleRate,
    speed,
  });
  const elapsed = Date.now() - started;
  const wav = Buffer.from(result.wav);
  if (wav.length <= 44) {
    throw new Error('The voice model returned no audio.');
  }
  if (
    wav.toString('latin1', 0, 4) !== 'RIFF' ||
    wav.toString('latin1', 8, 12) !== 'WAVE'
  ) {
    throw new Error('The voice model returned something that is not a WAV.');
  }
  const rate = wav.readUInt32LE(24);
  if (rate !== catalogue.sampleRate) {
    throw new Error(
      `The WAV is ${String(rate)} Hz, not ${String(catalogue.sampleRate)}.`,
    );
  }
  let sum = 0;
  let samples = 0;
  for (let at = 44; at + 1 < wav.length; at += 2) {
    const sample = wav.readInt16LE(at) / 32_768;
    sum += sample * sample;
    samples += 1;
  }
  const rms = Math.sqrt(sum / Math.max(samples, 1));
  if (rms < 0.001) {
    throw new Error('The WAV is silent.');
  }
  return {wav, seconds: samples / rate, elapsed, rms};
}

/* OOV: the stage-3 fallback must keep a word the lexicons do not know. */
const oovText = 'Kubernetes foobarbaz speech-host.ts ONNX qwen v0.1.0';
const oov = await phonemize(oovText);
if (oov.dropped !== 0 || oov.phonemes.length === 0) {
  throw new Error(
    `The OOV fallback dropped ${String(oov.dropped)} symbol(s) from ${oovText}`,
  );
}
console.log('OOV fallback: no words dropped');

/* Chunking: the host's splitter has to make several sentences. */
const chunkText =
  'First sentence. Second sentence! Third question? Fourth, with v1.2.3.';
const sentences = runtime.splitSpeechSentences(chunkText);
if (sentences.length < 4) {
  throw new Error(
    `The splitter made ${String(sentences.length)} sentence(s), expected 4.`,
  );
}
for (const [index, sentence] of sentences.entries()) {
  const piece = await render(sentence);
  console.log(
    `sentence ${String(index + 1)}/${String(sentences.length)}: ` +
      `${String(piece.elapsed)} ms, ${piece.seconds.toFixed(2)} s`,
  );
  await writeFile(out, piece.wav);
}

/*
 * Speed: the same sentence faster must come back shorter. The model's speed
 * tensor is the control; a client-side playback rate would not change the WAV.
 */
const speedText = 'The quick brown fox jumps over the lazy dog.';
const slow = await render(speedText, 0.8);
const fast = await render(speedText, 1.5);
if (!(fast.seconds < slow.seconds)) {
  throw new Error(
    `speed 1.5 produced ${fast.seconds.toFixed(2)} s and speed 0.8 ` +
      `${slow.seconds.toFixed(2)} s; the speed tensor is not reaching the model.`,
  );
}
console.log(
  `speed: 0.8 → ${slow.seconds.toFixed(2)} s, 1.5 → ${fast.seconds.toFixed(2)} s`,
);
await writeFile(out, fast.wav);
console.log(`wrote the last sentence to ${out}`);
await session.release();
