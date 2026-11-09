#!/usr/bin/env node
/**
 * The live user journeys: does the app do what it says, with the real model?
 *
 * The smoke check proves the window and the wiring against a stand-in server;
 * it cannot prove that the model, handed the tool list and a question, does the
 * thing. This script boots a real window against the server the person is
 * already running, drives the composer the way a person does, answers the
 * approval cards, and reads the turn back out of the harness log:
 *
 *   - the tool calls and their results, from `<userData>/harness/sessions/`;
 *   - the files they touched, from the temporary Space;
 *   - what the window drew, from the DOM.
 *
 * It is isolated on purpose: `MARIMO_USER_DATA_DIR` and `HOME` point at a fresh
 * temporary directory, so the real profile, Space, memory and settings are not
 * read or written. It never starts or stops the model server; that process is
 * the person's.
 *
 * Usage:
 *   node scripts/e2e.mjs [--url <openai base>] [--only <journey>] [--keep]
 *                        [--shot <dir>] [--no-network] [--recall-dir <dir>]
 *                        [--turn-timeout <ms>]
 *
 * `MARIMO_NO_SANDBOX=1` adds `--no-sandbox`, for a container where the SUID
 * helper cannot run. The suite is not part of CI: CI has a stand-in server and
 * no model.
 */
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {startApp, stopApp} from './app-process.mjs';
import {attach, until} from './window-driver.mjs';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electron = join(appRoot, 'node_modules', '.bin', 'electron');

/** A flag's value, or the fallback. */
function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(name);
const describe = (error) =>
  error instanceof Error ? error.message : String(error);

const baseUrl = flag(
  '--url',
  process.env['MARIMO_E2E_URL'] ?? 'http://127.0.0.1:8080/v1',
).replace(/\/+$/u, '');
const only = flag('--only', undefined);
const keep = has('--keep');
const shotFlag = flag('--shot', undefined);
const noNetwork = has('--no-network');
const recallDir = flag('--recall-dir', process.env['MARIMO_E2E_RECALL_DIR']);
const debugPort = Number(
  flag('--debug-port', process.env['MARIMO_E2E_DEBUG_PORT'] ?? 9319),
);
const turnTimeoutMs = Number(flag('--turn-timeout', 180_000));
const noSandbox = process.env['MARIMO_NO_SANDBOX'] === '1';
const modelFlag = flag('--model', undefined);

let userData;
let child;
let socket;
let client;
let pageConsole = [];
const appLog = [];
const results = [];
let shotDir;
let shotCount = 0;
let lead;
let writer;
let space;
let preflight;
let currentSession;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/** An expression in the window, answered as a value. */
async function evaluate(expression) {
  const {result} = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.value;
}

/** One bridge call, with its params embedded. */
async function call(method, params = {}) {
  return await evaluate(
    `window.marimo.call(${JSON.stringify(method)}, ${JSON.stringify(params)})`,
  );
}

async function waitForApp() {
  await until(
    'the chat window',
    async () =>
      (await evaluate(`(() => {
        const input = document.querySelector('textarea.composer-input');
        return input !== null && typeof window.marimo === 'object' &&
          typeof window.marimo.call === 'function';
      })()`)) === true
        ? true
        : undefined,
    {withinMs: 45_000},
  );
}

async function reload() {
  await client.send('Page.reload', {});
  await waitForApp();
}

async function sessionEvents(sessionId) {
  try {
    const text = await readFile(
      join(userData, 'harness', 'sessions', `${sessionId}.jsonl`),
      'utf8',
    );
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

async function approvalCard() {
  return await evaluate(`(() => {
    const card = document.querySelector('.approval');
    if (card === null) return null;
    return {
      heading: card.querySelector('.approval-head')?.textContent?.trim() ?? '',
      buttons: [...card.querySelectorAll('button')].map((entry) =>
        entry.textContent?.trim() ?? '',
      ),
    };
  })()`);
}

async function decide(decision) {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.approval-foot button')]
      .find((entry) => entry.textContent?.trim() === ${JSON.stringify(decision)});
    if (button === undefined) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) {
    throw new Error(`there is no ${decision} button on the approval card`);
  }
}

/**
 * Waits for one turn to settle.
 *
 * A gate parks the turn without a terminal record, so the card is checked
 * before the log: seeing a terminal while a card is up would be the app
 * answering a call somebody has not decided yet. One card per turn is the
 * expectation; a second one is a finding, not something to click through.
 */
async function waitForTurn(sessionId, before, options) {
  const started = Date.now();
  let decided = false;
  while (Date.now() - started < turnTimeoutMs) {
    const events = await sessionEvents(sessionId);
    const fresh = events.slice(before);
    const user = fresh.find((entry) => entry.type === 'user.message');
    const turnId = user?.turnId;
    const card = await approvalCard();
    if (card !== null) {
      if (decided) {
        await decide('Deny');
        throw new Error(`a second approval appeared: ${card.heading}`);
      }
      if (options.gate === undefined) {
        await decide('Deny');
        throw new Error(`an unexpected approval appeared: ${card.heading}`);
      }
      if (
        options.gate.heading !== undefined &&
        !card.heading.includes(options.gate.heading)
      ) {
        await decide('Deny');
        throw new Error(
          `the approval said "${card.heading}", not "${options.gate.heading}"`,
        );
      }
      await decide(
        options.gate.decision === 'deny' ? 'Deny' : 'Approve',
      );
      decided = true;
      await until(
        'the approval card to go',
        async () =>
          (await evaluate(`document.querySelector('.approval') === null`)) ===
          true
            ? true
            : undefined,
        {withinMs: 20_000},
      );
      continue;
    }
    if (turnId !== undefined) {
      const terminal = fresh.find(
        (entry) =>
          entry.turnId === turnId &&
          ['turn.completed', 'turn.failed', 'turn.aborted'].includes(
            entry.type,
          ),
      );
      if (terminal !== undefined) {
        return {
          turnId,
          terminal,
          events: fresh.filter((entry) => entry.turnId === turnId),
          gate: decided,
        };
      }
    }
    await pause(500);
  }
  const card = await approvalCard();
  throw new Error(
    `the turn did not settle in ${String(Math.round(turnTimeoutMs / 1000))}s` +
      (card === null ? '' : ` (an approval is waiting: ${card.heading})`),
  );
}

async function typeAndSend(text) {
  await until(
    'the composer',
    async () =>
      (await evaluate(
        `document.querySelector('textarea.composer-input') !== null`,
      )) === true
        ? true
        : undefined,
    {withinMs: 20_000},
  );
  const typed = await evaluate(`(() => {
    const input = document.querySelector('textarea.composer-input');
    if (input === null) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    ).set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', {bubbles: true}));
    return input.value.length > 0;
  })()`);
  check(typed === true, 'the composer could not take the message');
  await until(
    'the send button',
    async () =>
      (await evaluate(`(() => {
        const button = document.querySelector('.composer-send');
        return button !== null && button.disabled === false;
      })()`)) === true
        ? true
        : undefined,
    {withinMs: 20_000},
  );
  await evaluate(`document.querySelector('.composer-send')?.click()`);
}

async function runTurn(sessionId, text, options = {}) {
  currentSession = sessionId;
  const before = (await sessionEvents(sessionId)).length;
  await typeAndSend(text);
  const turn = await waitForTurn(sessionId, before, options);
  await pause(250);
  const names = turn.events
    .filter((entry) => entry.type === 'tool.call')
    .map((entry) => entry.tool);
  const answer = assistantText(turn);
  console.log(
    `   · ${names.length === 0 ? 'no tool calls' : names.join(', ')}` +
      ` | ${turn.terminal.type}` +
      (answer.length === 0 ? '' : ` | ${answer.replace(/\s+/gu, ' ').slice(0, 160)}`),
  );
  return turn;
}

function assistantText(turn) {
  return turn.events
    .filter(
      (entry) =>
        entry.type === 'assistant.message' &&
        typeof entry.text === 'string' &&
        entry.text.trim().length > 0,
    )
    .map((entry) => entry.text)
    .join('\n\n');
}

function callNames(turn) {
  return turn.events
    .filter((entry) => entry.type === 'tool.call')
    .map((entry) => entry.tool);
}

function toolCalls(turn) {
  return turn.events.filter((entry) => entry.type === 'tool.call');
}

function resultFor(turn, tool) {
  return turn.events
    .filter((entry) => entry.type === 'tool.result' && entry.tool === tool)
    .map((entry) => String(entry.result ?? ''))
    .join('\n');
}

function expectCompleted(turn) {
  check(
    turn.terminal.type === 'turn.completed',
    `the turn ended ${turn.terminal.type}: ${
      turn.terminal.message ?? '(no message)'
    }`,
  );
}

async function newSession() {
  const {session} = await call('sessions.create', {profileId: lead.id});
  await reload();
  currentSession = session.id;
  return session.id;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function openSettings() {
  await evaluate(`[...document.querySelectorAll('.head button')]
    .find((entry) => entry.textContent?.trim() === 'Settings')?.click()`);
  await until(
    'the settings dialog',
    async () =>
      (await evaluate(`document.querySelector('.settings-head') !== null`)) ===
      true
        ? true
        : undefined,
    {withinMs: 20_000},
  );
  await until(
    'the settings cards',
    async () =>
      (await evaluate(
        `document.querySelector('details.settings-section') !== null`,
      )) === true
        ? true
        : undefined,
    {withinMs: 20_000},
  );
}

async function closeSettings() {
  await evaluate(`[...document.querySelectorAll('.settings-head button')]
    .find((entry) => entry.textContent?.trim() === 'Back to chat')?.click()`);
  await waitForApp();
}

async function openSection(title) {
  await evaluate(`(() => {
    const section = [...document.querySelectorAll('details.settings-section')]
      .find((entry) => entry.querySelector('h3')?.textContent === ${JSON.stringify(title)});
    if (section !== undefined && !section.open) {
      section.querySelector('summary')?.click();
    }
  })()`);
  await until(
    `the ${title} section`,
    async () =>
      (await evaluate(`(() => {
        const section = [...document.querySelectorAll('details.settings-section')]
          .find((entry) => entry.querySelector('h3')?.textContent === ${JSON.stringify(title)});
        return section?.open === true;
      })()`)) === true
        ? true
        : undefined,
    {withinMs: 20_000},
  );
}

async function documentsOpen() {
  return (
    (await evaluate(`[...document.querySelectorAll('.head button')]
      .find((entry) => entry.textContent?.trim() === 'Documents')
      ?.getAttribute('aria-expanded') === 'true'`)) === true
  );
}

async function toggleDocuments() {
  await evaluate(`[...document.querySelectorAll('.head button')]
    .find((entry) => entry.textContent?.trim() === 'Documents')?.click()`);
  await pause(300);
}

async function shot(name) {
  if (shotDir === undefined) {
    return;
  }
  shotCount += 1;
  try {
    const {data} = await client.send('Page.captureScreenshot', {format: 'png'});
    const file = join(
      shotDir,
      `${String(shotCount).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/giu, '-')}.png`,
    );
    await writeFile(file, Buffer.from(data, 'base64'));
  } catch (error) {
    console.log(`   ! could not take a screenshot: ${describe(error)}`);
  }
}

/** The server's readiness, read before anything is booted. */
async function probe() {
  let models;
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`GET /models answered ${String(response.status)}`);
    }
    models =
      (await response.json()).data
        ?.map((entry) => entry?.id)
        .filter((id) => typeof id === 'string') ?? [];
  } catch (error) {
    return {
      ok: false,
      problem: `The model server at ${baseUrl} did not answer: ${describe(error)}`,
    };
  }
  if (models.length === 0) {
    return {ok: false, problem: `The server at ${baseUrl} reports no models.`};
  }
  const root = baseUrl.replace(/\/v1$/iu, '');
  let props = {};
  try {
    props =
      (await (
        await fetch(`${root}/props`, {signal: AbortSignal.timeout(5_000)})
      ).json()) ?? {};
  } catch {
    // A server without /props is still usable; the app falls back too.
  }
  const caps = props.chat_template_caps ?? {};
  if (caps.supports_tools === false) {
    return {
      ok: false,
      problem:
        'The server’s chat template cannot call tools; the journeys need a ' +
        'model whose template can.',
    };
  }
  const vision = props.modalities?.vision !== false;
  const context =
    props.default_generation_settings?.n_ctx ??
    props.n_ctx ??
    16_384;
  const model = modelFlag ?? models[0];
  if (!models.includes(model)) {
    return {
      ok: false,
      problem: `The server does not list "${model}"; it reports ${models.join(', ')}.`,
    };
  }
  let network = false;
  if (!noNetwork) {
    try {
      network = (await fetch('https://example.com', {
        signal: AbortSignal.timeout(5_000),
      })).ok;
    } catch {
      network = false;
    }
  }
  return {
    ok: true,
    model,
    models,
    context,
    vision,
    network,
    tools: caps.supports_tools !== false,
  };
}

async function boot() {
  userData = await mkdtemp(join(appRoot, '.marimo-e2e-'));
  const home = join(userData, 'home');
  await mkdir(home, {recursive: true});
  const settings = {
    version: 4,
    setupSeen: true,
    modelServer: {
      url: baseUrl,
      model: preflight.model,
      contextTokens: preflight.context,
    },
    ...(recallDir === undefined
      ? {recall: {enabled: false}}
      : {
          recall: {
            enabled: true,
            memory: true,
            workspace: true,
            conversations: true,
            media: true,
          },
        }),
  };
  await writeFile(
    join(userData, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    'utf8',
  );

  const args = [appRoot, `--remote-debugging-port=${String(debugPort)}`];
  if (noSandbox) {
    args.push('--no-sandbox');
  }
  child = startApp({
    command: electron,
    args,
    cwd: appRoot,
    env: {
      ...process.env,
      MARIMO_USER_DATA_DIR: userData,
      HOME: home,
      USERPROFILE: home,
      ...(recallDir === undefined ? {} : {MARIMO_MODEL_DIR: recallDir}),
    },
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      appLog.push(chunk);
      if (appLog.length > 400) {
        appLog.shift();
      }
    });
  }

  const page = await until('the window', async () => {
    const response = await fetch(
      `http://127.0.0.1:${String(debugPort)}/json/list`,
    );
    const targets = await response.json();
    return targets.find(
      (entry) => entry.type === 'page' && entry.url.includes('index.html'),
    );
  });

  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener(
      'error',
      () => {
        reject(new Error('could not attach to the window'));
      },
      {once: true},
    );
  });
  client = await attach(socket);
  pageConsole = client.console;
  await waitForApp();

  shotDir =
    shotFlag ?? join(userData, 'shots');
  await mkdir(shotDir, {recursive: true});
}

async function choosePower() {
  await openSettings();
  const title = await evaluate(`(() => {
    const section = [...document.querySelectorAll('details.settings-section')]
      .find((entry) =>
        (entry.querySelector('h3')?.textContent ?? '').endsWith('can do'));
    return section?.querySelector('h3')?.textContent ?? null;
  })()`);
  check(
    typeof title === 'string' && title.length > 0,
    'the settings screen has no tool section',
  );
  await openSection(title);
  const clicked = await evaluate(`(() => {
    const card = document.querySelector('[data-control-preset="power"]');
    if (card === null) return false;
    card.click();
    return true;
  })()`);
  check(clicked === true, 'the settings screen has no Power control card');
  await until(
    'the Power grant',
    async () =>
      (await evaluate(`document.querySelector('[data-control-preset="power"]')
        ?.getAttribute('aria-pressed') === 'true'`)) === true
        ? true
        : undefined,
    {withinMs: 20_000},
  );
  const {profiles} = await call('profiles.list', {});
  const now = profiles.find((entry) => entry.id === lead.id);
  check(
    Array.isArray(now?.enabledTools) && now.enabledTools.includes('run_shell'),
    'choosing Power did not grant the shell',
  );
  await closeSettings();
}

async function seedSpace() {
  await mkdir(join(space, 'ideas'), {recursive: true});
  await writeFile(
    join(space, 'notes.txt'),
    'The launch code is moss-42. Keep this line.\n',
    'utf8',
  );
  await writeFile(
    join(space, 'existing.txt'),
    'This file already exists.\n',
    'utf8',
  );
  await writeFile(
    join(space, 'ideas', 'seed.txt'),
    'A seed in the ideas folder.\n',
    'utf8',
  );
  await copyFile(
    join(appRoot, 'public', 'marimo-logo.png'),
    join(space, 'moss.png'),
  );
}

async function seedSkill() {
  await call('skills.save', {
    draft: {
      name: 'house-style',
      description: 'How to answer questions about the house colour.',
      instructions:
        'When the person asks for the house colour, answer exactly: moss green.',
    },
  });
  const {profiles} = await call('profiles.list', {});
  const now = profiles.find((entry) => entry.id === lead.id);
  const enabledSkills = [...(now?.enabledSkills ?? [])];
  if (!enabledSkills.includes('house-style')) {
    enabledSkills.push('house-style');
  }
  await call('profiles.update', {
    profileId: lead.id,
    patch: {enabledSkills},
  });
}

async function seedWriter() {
  const made = await call('profiles.create', {draft: {name: 'Writer'}});
  writer = made.created;
  await call('profiles.select', {profileId: lead.id});
  await reload();
}

async function setup() {
  const {profiles, activeProfileId} = await call('profiles.list', {});
  lead =
    profiles.find((entry) => entry.id === activeProfileId) ?? profiles[0];
  check(lead !== undefined, 'the app has no profile');
  const {workspaces, activeWorkspaceId} = await call('workspaces.list', {});
  space = workspaces.find((entry) => entry.id === activeWorkspaceId)?.path;
  check(
    typeof space === 'string' && space.length > 0,
    'the app has no Space',
  );
  await choosePower();
  await seedSpace();
  await seedSkill();
  await seedWriter();
}

/* ------------------------------------------------------------------ journeys */

const JOURNEYS = [
  {
    name: 'chat',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Hello. Tell me in one sentence what you can do in this Space.',
      );
      expectCompleted(turn);
      check(
        assistantText(turn).trim().length > 20,
        'the answer was empty or too short',
      );
    },
  },
  {
    name: 'list-and-read',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'List the files here, then read notes.txt and tell me the launch code.',
      );
      expectCompleted(turn);
      const names = callNames(turn);
      check(names.includes('list_dir'), 'list_dir was not called');
      check(names.includes('read_file'), 'read_file was not called');
      check(
        assistantText(turn).includes('moss-42'),
        `the answer did not read the launch code: ${assistantText(turn)}`,
      );
    },
  },
  {
    name: 'create-file',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Create hello.txt containing exactly: MARIMO-E2E-ONE',
      );
      expectCompleted(turn);
      check(callNames(turn).includes('write_file'), 'write_file was not called');
      const content = await readFile(join(space, 'hello.txt'), 'utf8').catch(
        () => '',
      );
      check(
        content.includes('MARIMO-E2E-ONE'),
        'hello.txt was not written with the marker',
      );
      if (!(await documentsOpen())) {
        await toggleDocuments();
      }
      const listed = await until('the Documents row', async () => {
        const value = await evaluate(`(() => {
          return [...document.querySelectorAll('.documents-row-name')]
            .map((entry) => entry.textContent?.trim() ?? '');
        })()`);
        return Array.isArray(value) && value.includes('hello.txt')
          ? true
          : undefined;
      }).catch(() => undefined);
      await toggleDocuments();
      check(listed === true, 'the Documents panel does not list hello.txt');
    },
  },
  {
    name: 'overwrite-approve',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Change hello.txt so it contains exactly: MARIMO-E2E-TWO',
        {gate: {decision: 'approve', heading: 'Overwrite'}},
      );
      expectCompleted(turn);
      check(callNames(turn).includes('write_file'), 'write_file was not called');
      const content = await readFile(join(space, 'hello.txt'), 'utf8').catch(
        () => '',
      );
      check(
        content.includes('MARIMO-E2E-TWO'),
        'the approved overwrite did not reach the file',
      );
    },
  },
  {
    name: 'overwrite-deny',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Change hello.txt so it contains exactly: MARIMO-E2E-THREE',
        {gate: {decision: 'deny', heading: 'Overwrite'}},
      );
      expectCompleted(turn);
      const content = await readFile(join(space, 'hello.txt'), 'utf8').catch(
        () => '',
      );
      check(
        content.includes('MARIMO-E2E-TWO') &&
          !content.includes('MARIMO-E2E-THREE'),
        'the denied overwrite changed the file',
      );
    },
  },
  {
    name: 'rename',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Rename hello.txt to greeting.txt.',
      );
      expectCompleted(turn);
      const names = callNames(turn);
      check(
        names.includes('rename_file') || names.includes('move_file'),
        'neither rename_file nor move_file was called',
      );
      check(
        await exists(join(space, 'greeting.txt')),
        'greeting.txt does not exist',
      );
      check(
        !(await exists(join(space, 'hello.txt'))),
        'hello.txt still exists after the rename',
      );
    },
  },
  {
    name: 'move',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Move greeting.txt into the ideas folder.',
      );
      expectCompleted(turn);
      check(callNames(turn).includes('move_file'), 'move_file was not called');
      check(
        await exists(join(space, 'ideas', 'greeting.txt')),
        'greeting.txt did not move into ideas',
      );
      check(
        !(await exists(join(space, 'greeting.txt'))),
        'greeting.txt is still in the root',
      );
    },
  },
  {
    name: 'delete',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Delete ideas/greeting.txt.',
        {gate: {decision: 'approve', heading: 'Delete'}},
      );
      expectCompleted(turn);
      check(callNames(turn).includes('delete_file'), 'delete_file was not called');
      check(
        !(await exists(join(space, 'ideas', 'greeting.txt'))),
        'the approved delete left the file behind',
      );
    },
  },
  {
    name: 'shell',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Run the command `printf MARIMO-E2E` here and show me the output.',
        {gate: {decision: 'approve', heading: 'Run'}},
      );
      expectCompleted(turn);
      check(callNames(turn).includes('run_shell'), 'run_shell was not called');
      check(
        resultFor(turn, 'run_shell').includes('MARIMO-E2E'),
        'the shell result did not contain the output',
      );
    },
  },
  {
    name: 'knowledge-search',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Search this Space for the phrase "launch code" and tell me which file contains it.',
      );
      expectCompleted(turn);
      const names = callNames(turn);
      check(
        names.includes('search_knowledge_base') || names.includes('read_file'),
        'neither search_knowledge_base nor read_file was called',
      );
      const answer = assistantText(turn);
      check(
        answer.includes('moss-42') || answer.includes('notes.txt'),
        `the answer did not name the code or the file: ${answer}`,
      );
    },
  },
  {
    name: 'picture',
    skip: () =>
      preflight.vision ? undefined : 'the server does not report vision',
    async run() {
      const turn = await runTurn(await newSession(), 'What is in moss.png?');
      expectCompleted(turn);
      const user = turn.events.find((entry) => entry.type === 'user.message');
      check(
        Array.isArray(user?.attachments) &&
          user.attachments.some((entry) => entry.path === 'moss.png'),
        'the named picture was not attached to the turn',
      );
      const answer = assistantText(turn);
      check(
        !/(no vision|can(?:not|'t) see|don't have vision|do not have vision)/iu.test(
          answer,
        ),
        `the bot claimed it cannot see: ${answer}`,
      );
      check(
        /(green|moss|plant|ball|character|fuzzy|fluffy)/iu.test(answer),
        `the answer did not describe the picture: ${answer}`,
      );
    },
  },
  {
    name: 'memory',
    async run() {
      const first = await newSession();
      expectCompleted(
        await runTurn(first, 'My name is Tarlow.'),
      );
      const memory = await readFile(
        join(userData, 'memory', lead.id, 'memory.md'),
        'utf8',
      ).catch(() => '');
      check(
        memory.includes('Tarlow'),
        'the memory file did not record the name',
      );
      const turn = await runTurn(
        await newSession(),
        'What is my name?',
      );
      expectCompleted(turn);
      check(
        assistantText(turn).includes('Tarlow'),
        `the new chat did not remember the name: ${assistantText(turn)}`,
      );
    },
  },
  {
    name: 'skill',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'What is the house colour for this project?',
      );
      expectCompleted(turn);
      check(callNames(turn).includes('load_skill'), 'load_skill was not called');
      check(
        assistantText(turn).toLowerCase().includes('moss green'),
        `the answer did not follow the skill: ${assistantText(turn)}`,
      );
    },
  },
  {
    name: 'jobs',
    async run() {
      const created = await runTurn(
        await newSession(),
        'Create a job called Stretch that reminds me to stretch every day at 9am.',
        {gate: {decision: 'approve'}},
      );
      expectCompleted(created);
      check(callNames(created).includes('create_job'), 'create_job was not called');
      const jobs = await call('jobs.list', {});
      const job = jobs.jobs?.find((entry) =>
        (entry.job?.name ?? '').includes('Stretch'),
      );
      check(job !== undefined, 'the created job is not in jobs.list');
      await openSettings();
      await openSection('Jobs');
      const listed = await evaluate(`(() => {
        return [...document.querySelectorAll('.settings-job')]
          .map((entry) => entry.textContent ?? '')
          .some((text) => text.includes('Stretch'));
      })()`);
      await closeSettings();
      check(listed === true, 'the Jobs card does not list Stretch');

      const deleted = await runTurn(
        await newSession(),
        'Delete the Stretch job.',
        {gate: {decision: 'approve'}},
      );
      expectCompleted(deleted);
      check(callNames(deleted).includes('delete_job'), 'delete_job was not called');
      const after = await call('jobs.list', {});
      check(
        !(after.jobs ?? []).some((entry) =>
          (entry.job?.name ?? '').includes('Stretch'),
        ),
        'the job survived the delete',
      );
    },
  },
  {
    name: 'delegation',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Ask Writer to write a two-line poem about moss.',
      );
      expectCompleted(turn);
      const ask = toolCalls(turn).find((entry) => entry.tool === 'ask_agent');
      check(ask !== undefined, 'ask_agent was not called');
      check(
        JSON.stringify(ask.args ?? {}).includes('Writer'),
        'the delegation did not name Writer',
      );
      const result = resultFor(turn, 'ask_agent');
      check(
        result.trim().length > 20,
        `the helper's answer was empty: ${result}`,
      );
      check(
        /moss/iu.test(result + assistantText(turn)),
        'neither the helper nor the answer mentioned moss',
      );
      const drawn = await evaluate(
        `[...document.querySelectorAll('.call-name')]
          .some((entry) => entry.textContent?.trim() === 'ask_agent')`,
      );
      check(drawn === true, 'the window did not draw the delegation call');
    },
  },
  {
    name: 'mention',
    async run() {
      const session = await newSession();
      await call('sessions.setParticipants', {
        profileId: lead.id,
        sessionId: session,
        agentIds: [lead.id, writer.id],
      });
      await reload();
      const turn = await runTurn(
        session,
        '@Writer Introduce yourself in one sentence.',
      );
      expectCompleted(turn);
      const assistant = turn.events.find(
        (entry) => entry.type === 'assistant.message',
      );
      check(
        assistant?.author === 'Writer',
        `the turn was answered by ${assistant?.author ?? 'nobody'}`,
      );
      check(
        (assistant.text ?? '').trim().length > 0,
        'Writer said nothing',
      );
    },
  },
  {
    name: 'web-search',
    skip: () =>
      noNetwork
        ? '--no-network'
        : preflight.network
          ? undefined
          : 'the network probe failed',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Search the web for the capital of Iceland.',
      );
      expectCompleted(turn);
      check(callNames(turn).includes('web_search'), 'web_search was not called');
      /*
       * The engine can challenge one attempt and answer the next; this run saw
       * exactly that, with the model retrying on its own. What the person gets
       * is the last attempt, so that is what the journey judges — an earlier
       * challenge is a note, not a failure of the capability.
       */
      const searches = turn.events
        .filter(
          (entry) =>
            entry.type === 'tool.result' && entry.tool === 'web_search',
        )
        .map((entry) => String(entry.result ?? ''));
      const last = searches.at(-1) ?? '';
      check(
        !/(anti-bot|challenge|blocked|failed|no web results)/iu.test(last),
        `the search engine did not return results: ${last.slice(0, 200)}`,
      );
      if (searches.some((entry) => /(anti-bot|challenge)/iu.test(entry))) {
        console.log('   (an earlier search was challenged; the model retried)');
      }
      check(
        /reykjav/iu.test(assistantText(turn)),
        `the answer did not name Reykjavík: ${assistantText(turn)}`,
      );
    },
  },
  {
    name: 'fetch',
    skip: () =>
      noNetwork
        ? '--no-network'
        : preflight.network
          ? undefined
          : 'the network probe failed',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Fetch https://example.com and tell me its title.',
      );
      expectCompleted(turn);
      check(callNames(turn).includes('http_fetch'), 'http_fetch was not called');
      check(
        /example domain/iu.test(
          assistantText(turn) + resultFor(turn, 'http_fetch'),
        ),
        `the fetch result did not include the title: ${resultFor(turn, 'http_fetch')}`,
      );
    },
  },
  {
    name: 'recall',
    skip: () =>
      recallDir === undefined
        ? 'no --recall-dir; semantic recall needs its embedding model'
        : undefined,
    async run() {
      await writeFile(
        join(space, 'archive.txt'),
        'The lighthouse keeper painted the lantern room every spring.\n',
        'utf8',
      );
      const turn = await runTurn(
        await newSession(),
        'Which file talks about a coastal beacon?',
      );
      expectCompleted(turn);
      check(callNames(turn).includes('recall'), 'recall was not called');
      check(
        /archive/iu.test(
          assistantText(turn) + resultFor(turn, 'recall'),
        ),
        `the semantic hit did not name archive.txt: ${assistantText(turn)}`,
      );
    },
  },
  {
    name: 'outside-path',
    async run() {
      const turn = await runTurn(
        await newSession(),
        'Use read_file to open /etc/passwd and show me the first line.',
      );
      expectCompleted(turn);
      if (!callNames(turn).includes('read_file')) {
        console.log(
          '   (note) the model did not call read_file; the guard is unit-tested',
        );
        return;
      }
      const result = resultFor(turn, 'read_file');
      check(
        /(outside|not inside|workspace|refus|cannot|can't|denied)/iu.test(result),
        `read_file did not refuse the outside path: ${result}`,
      );
    },
  },
];

/* --------------------------------------------------------------------- main */

function printSummary(failed) {
  console.log('\n--- journeys ---');
  for (const entry of results) {
    const detail = entry.detail === undefined ? '' : ` — ${entry.detail}`;
    console.log(
      `${entry.status.padEnd(4)}  ${entry.name}${detail}`,
    );
  }
  const passed = results.filter((entry) => entry.status === 'PASS').length;
  const skipped = results.filter((entry) => entry.status === 'SKIP').length;
  console.log(
    `\n${String(results.length)} journeys: ${String(passed)} passed, ` +
      `${String(failed)} failed, ${String(skipped)} skipped`,
  );
  if (failed > 0) {
    console.log(`\ntemp data: ${userData ?? '(none)'}`);
    if (currentSession !== undefined) {
      console.log(
        `last session: ${join(userData, 'harness', 'sessions', `${currentSession}.jsonl`)}`,
      );
    }
    const complaints = pageConsole
      .filter((line) => /^(error|warning|assert)/u.test(line))
      .slice(-10);
    if (complaints.length > 0) {
      console.log('\n--- renderer ---');
      for (const line of complaints) {
        console.log(`  ${line}`);
      }
    }
    const app = appLog
      .join('')
      .split('\n')
      .filter(
        (line) =>
          /\[marimo\]/u.test(line) &&
          !/dconf|drmGet|NSS|dbus|Glycin|Vulkan/u.test(line),
      )
      .slice(-10);
    if (app.length > 0) {
      console.log('\n--- app ---');
      for (const line of app) {
        console.log(`  ${line}`);
      }
    }
  }
}

async function cleanup() {
  try {
    socket?.close();
  } catch {
    // The socket is a courtesy; the process group is what matters.
  }
  await stopApp();
  if (userData !== undefined) {
    /*
     * A failed journey is the one time the temp data is the evidence: the
     * session log, the Space and the screenshots are what the report points at.
     * Keep it unless the run was clean.
     */
    const failed = results.some((entry) => entry.status === 'FAIL');
    if (keep || failed) {
      console.log(`\nkept: ${userData}`);
    } else {
      /*
       * A gvfs daemon can still be writing metadata into the temporary HOME
       * after the app is gone, so a single `rm` races it. Retry, and never let
       * the cleanup turn a green run into an exception.
       */
      try {
        await rm(userData, {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 150,
        });
      } catch (error) {
        console.log(`\ncould not remove ${userData}: ${describe(error)}`);
      }
    }
  }
}

async function main() {
  preflight = await probe();
  if (!preflight.ok) {
    console.error(`✗ ${preflight.problem}`);
    process.exitCode = 2;
    return;
  }
  console.log(
    `server ${baseUrl} · model ${preflight.model} · context ${String(preflight.context)}` +
      ` · tools ${preflight.tools ? 'yes' : 'unknown'} · vision ${preflight.vision ? 'yes' : 'no'}` +
      ` · network ${preflight.network ? 'yes' : 'no'}`,
  );
  if (noNetwork || preflight.network === false) {
    console.log('web journeys will be skipped');
  }
  try {
    await boot();
    await setup();
    console.log(`space ${space}`);
    for (const journey of JOURNEYS) {
      if (only !== undefined && journey.name !== only) {
        continue;
      }
      const skip = journey.skip?.();
      if (skip !== undefined) {
        results.push({name: journey.name, status: 'SKIP', detail: skip});
        console.log(`\n→ ${journey.name}: skipped (${skip})`);
        continue;
      }
      console.log(`\n→ ${journey.name}`);
      try {
        await journey.run();
        results.push({name: journey.name, status: 'PASS'});
        console.log(`✓ ${journey.name}`);
        await shot(journey.name);
      } catch (error) {
        const detail = describe(error);
        results.push({
          name: journey.name,
          status: 'FAIL',
          detail,
        });
        console.error(`✗ ${journey.name}: ${detail}`);
        await shot(`${journey.name}-failed`);
      }
    }
  } finally {
    const failed = results.filter((entry) => entry.status === 'FAIL').length;
    printSummary(failed);
    await cleanup();
    if (failed > 0) {
      process.exitCode = 1;
    }
  }
}

await main().catch(async (error) => {
  console.error(`✗ ${describe(error)}`);
  process.exitCode = 1;
  await cleanup();
});
