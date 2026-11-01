#!/usr/bin/env node
/**
 * A llama-server that answers the smoke check.
 *
 * The smoke check is about the window, the preload and the IPC path; the model
 * is four gigabytes of weights and a minute of loading it would prove none of
 * those. So this stands in for the engine: it speaks the same handful of routes
 * the app calls, on the port it is given, and nothing else. The real engine is
 * still what the live checks use when they exist.
 *
 * It deliberately does not import the app. If it did, a broken build could make
 * the stand-in agree with the bug.
 */
import {createServer} from 'node:http';

const argv = process.argv.slice(2);
const portIndex = argv.indexOf('--port');
const port = Number(portIndex >= 0 ? argv[portIndex + 1] : 0);
const hostIndex = argv.indexOf('--host');
const host = hostIndex >= 0 ? argv[hostIndex + 1] : '127.0.0.1';

/** A tenth of a second of silence, so a spoken reply is a valid WAV. */
function silentWav() {
  const samples = 2400;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24_000, 24);
  buffer.writeUInt32LE(48_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

function json(response, status, value) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = request.url ?? '/';
    if (url === '/v1/health' || url === '/health') {
      json(response, 200, {status: 'ok'});
      return;
    }
    if (url === '/v1/models') {
      json(response, 200, {
        object: 'list',
        data: [
          {
            id: 'lfm3-1.7b',
            object: 'model',
            created: 0,
            owned_by: 'local',
          },
        ],
      });
      return;
    }
    if (url === '/props') {
      json(response, 200, {
        modalities: {vision: true, audio: true},
        default_generation_settings: {},
      });
      return;
    }
    if (url === '/tts') {
      response.writeHead(200, {'content-type': 'audio/wav'});
      response.end(silentWav());
      return;
    }
    if (url.endsWith('/chat/completions')) {
      let request_ = {};
      try {
        request_ = JSON.parse(body);
      } catch {
        // The smoke check never sends malformed JSON; a refusal is still a
        // better answer than a crash.
      }
      const content = 'Smoke answer from the stand-in engine.';
      if (request_.stream === true) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const id = 'smoke-1';
        for (const delta of [
          {role: 'assistant', content: ''},
          {content},
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              choices: [{index: 0, delta, finish_reason: null}],
            })}\n\n`,
          );
        }
        response.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
            usage: {prompt_tokens: 4, completion_tokens: 8, total_tokens: 12},
          })}\n\n`,
        );
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      json(response, 200, {
        id: 'smoke-1',
        object: 'chat.completion',
        created: 0,
        model: 'lfm3-1.7b',
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content},
            finish_reason: 'stop',
          },
        ],
        usage: {prompt_tokens: 4, completion_tokens: 8, total_tokens: 12},
      });
      return;
    }
    if (url.endsWith('/audio/transcriptions')) {
      json(response, 200, {text: 'smoke transcript'});
      return;
    }
    json(response, 404, {error: {message: `no route ${url}`}});
  });
});

server.listen(port, host, () => {
  process.stdout.write(`smoke engine listening on ${host}:${String(port)}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}
