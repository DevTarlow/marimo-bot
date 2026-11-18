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

const sentences = [
  'Hello. This is what I sound like.',
  'The meeting is at 3:45pm on 2026-10-13, and it cost $24.5B.',
];
for (const [index, text] of sentences.entries()) {
  const started = Date.now();
  const result = await runtime.synthesize({
    text,
    vocab,
    voicePack: pack,
    session: speechSession,
    phonemize,
    sampleRate: catalogue.sampleRate,
  });
  const elapsed = Date.now() - started;
  const wav = Buffer.from(result.wav);
  if (wav.length <= 44) {
    throw new Error(
      `The voice model returned no audio for sentence ${index + 1}.`,
    );
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
    throw new Error(`The WAV for sentence ${index + 1} is silent.`);
  }
  console.log(
    `sentence ${String(index + 1)}: ${String(elapsed)} ms, ` +
      `${(samples / rate).toFixed(2)} s, rms ${rms.toFixed(4)}`,
  );
  await writeFile(out, wav);
}

console.log(`wrote the last sentence to ${out}`);
await session.release();
