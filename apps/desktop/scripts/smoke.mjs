#!/usr/bin/env node
/**
 * The smoke check: does the app actually open, and does the window actually
 * work?
 *
 * It launches a real Electron window against a throwaway user-data directory,
 * attaches to it over the DevTools protocol, and asks the renderer to prove
 * itself: that the preload bridge is there, that it can answer a call, and that
 * the React tree mounted. Then it takes a picture, because "the DOM says it
 * rendered" and "it rendered" are different claims and only one of them is worth
 * anything.
 *
 * Three things about how it is built are deliberate:
 *
 * - **It measures the real thing.** The checks run inside the packaged renderer
 *   over the same IPC path the app uses, not against a mocked bridge, so a
 *   preload that was never rebuilt fails here.
 * - **It has no dependencies.** Node 22 ships a WebSocket client, so the
 *   DevTools protocol is spoken directly rather than through puppeteer — one
 *   less package to keep current for a check that must not itself rot.
 * - **It never touches real state.** `MARIMO_USER_DATA_DIR` points at a fresh
 *   temporary directory, which is also what keeps it from fighting a running
 *   copy of the app for the single-instance lock; `HOME` (and `USERPROFILE`)
 *   point inside it too, so the starting Space the app creates for itself lands
 *   there rather than in the real home directory.
 *
 * And it puts the app away again before it exits, on every path out, including a
 * Ctrl-C: this opens a real window on whatever display the check is running on,
 * and an agent left sitting in somebody's tray afterwards is a mess they have to
 * clean up rather than a result. `app-process.mjs` is where that lives, and why
 * it means the process group rather than the pid.
 *
 * Usage:
 *   node scripts/smoke.mjs [--shot <file.png>]
 *
 * `MARIMO_NO_SANDBOX=1` adds `--no-sandbox`, which is needed in a container
 * where `chrome-sandbox` cannot be setuid-root. It is opt-in because it is a
 * real reduction in isolation and must not be what a normal run quietly gets.
 */
import {mkdir, mkdtemp, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {appIsRunning, startApp, stopApp} from './app-process.mjs';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const electron = join(appRoot, 'node_modules', '.bin', 'electron');

/** A port nothing else is likely to want, overridable for a busy machine. */
const DEBUG_PORT = Number(process.env['MARIMO_DEBUG_PORT'] ?? 9317);
const DEADLINE_MS = Number(process.env['MARIMO_SMOKE_TIMEOUT'] ?? 45_000);

const shotIndex = process.argv.indexOf('--shot');
const shotFile = shotIndex >= 0 ? process.argv[shotIndex + 1] : undefined;

/**
 * `--theme light|dark` clicks the switch before capturing.
 *
 * Both token blocks have to be looked at. A token declared in one and missed in
 * the other is not a styling bug that shows up as "slightly off" — it is a
 * component that renders invisibly in one mode, which is a bug exactly half the
 * users would have and nobody would report clearly.
 */
const themeIndex = process.argv.indexOf('--theme');
const wantedTheme = themeIndex >= 0 ? process.argv[themeIndex + 1] : undefined;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

/** Waits for something, or gives up. */
async function until(
  what,
  attempt,
  {everyMs = 250, withinMs = DEADLINE_MS} = {},
) {
  const deadline = Date.now() + withinMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await attempt();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(
    `timed out waiting for ${what}${last ? `: ${last.message}` : ''}`,
  );
}

async function main() {
  const userData = await mkdtemp(join(tmpdir(), 'marimo-smoke-'));
  /*
   * A home of the check's own, because the app creates its starting Space as
   * `<home>/Marimo`. Pinning only the user-data directory would leave that folder
   * in the home of whoever ran the check — which is the opposite of "never
   * touches real state".
   */
  const home = join(userData, 'home');
  await mkdir(home, {recursive: true});
  const args = [appRoot, `--remote-debugging-port=${DEBUG_PORT}`];
  if (process.env['MARIMO_NO_SANDBOX'] === '1') {
    args.push('--no-sandbox');
  }

  const child = startApp({
    command: electron,
    args,
    env: {
      ...process.env,
      MARIMO_USER_DATA_DIR: userData,
      HOME: home,
      USERPROFILE: home,
    },
  });

  const log = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => log.push(chunk));
  }

  let socket;
  try {
    /*
     * `/json/list` answers only once the first page exists, so this doubles as
     * "the window was created" — there is nothing to attach to before that.
     */
    const page = await until('the window to appear', async () => {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      /*
       * The main window by name, not the first page. There are two windows now —
       * the app and the floating pet — and "the first page" is whichever the
       * debugger happened to list first, which changes with the order they open
       * in. Picking the wrong one made this check fail on a build that was fine.
       */
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

    const {send, console: pageConsole} = await attach(socket);

    /**
     * An expression in the window, answered as a value.
     *
     * Every DOM assertion below is this, so that the checks read as what they
     * are asking rather than as DevTools protocol plumbing.
     */
    const evaluate = async (expression) => {
      const {result} = await send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return result?.value;
    };

    /**
     * Reloads the window and waits for the *new* document.
     *
     * A reload is not instant, and the document being replaced answers every
     * question just as well — so a marker set before it is what says which
     * window is on screen. Without one, a check can pass against the window it
     * was about to replace, which is exactly the state a stale bundle looks
     * healthy in.
     */
    const reload = async () => {
      await evaluate(`window.__smokeReload = true`);
      await send('Page.reload', {});
      await until('the window to come back', async () =>
        (await evaluate(`window.__smokeReload === true`)) === false
          ? true
          : undefined,
      );
    };

    const probe = await until('the renderer to mount', async () => {
      const {result} = await send('Runtime.evaluate', {
        expression: PROBE,
        awaitPromise: true,
        returnByValue: true,
      });
      const value = result?.value;
      return value?.mounted === true ? value : undefined;
    });

    ok(`the window opened (${probe.title})`);
    ok(`the preload bridge answered: ${probe.product} ${probe.version}`);
    ok(`the renderer mounted with ${probe.rootChildren} child element(s)`);

    /*
     * The agent's own spine. A preload that loads proves nothing about whether
     * the runtime, the stores and the IPC handlers behind it are connected —
     * these three calls are what prove it.
     */
    if (typeof probe.profileCount !== 'number' || probe.profileCount < 1) {
      fail('the app has no agent profiles, so the agent did not start');
    } else {
      ok(`the agent is running with ${probe.profileCount} profile(s)`);
    }

    if (typeof probe.sessionId !== 'string' || probe.sessionId.length === 0) {
      fail('a conversation could not be started');
    } else {
      ok(`a conversation was created (${probe.sessionId})`);
    }

    /*
     * At least one, not exactly one: the window opens a conversation of its own
     * on first paint, so by the time this check runs there are usually two. What
     * is being asserted is that a conversation this probe created is *listed* —
     * which is what proves the store, the index and the IPC path agree.
     */
    if (
      typeof probe.sessionCount !== 'number' ||
      probe.sessionCount < 1 ||
      !Array.isArray(probe.listedIds) ||
      !probe.listedIds.includes(probe.sessionId)
    ) {
      fail(
        `the conversation just created was not listed (${probe.sessionCount} listed)`,
      );
    } else {
      ok('the conversation was listed and read back');
    }

    /*
     * The starting Space, before anything has chosen one.
     *
     * A fresh install used to be seeded with the home directory itself, which
     * confined the agent to everything the person owned and showed that as if it
     * were a project. What this asserts is the whole first change in one place:
     * one Space, named and pointed at `<home>/Marimo`, and the folder actually on
     * disk — the store creates it, and a document naming a folder that is not
     * there would leave every file tool reading nothing.
     */
    const seeded = JSON.parse(
      await evaluate(`(async () => {
        const listed = await window.marimo.call('workspaces.list', {});
        return JSON.stringify(listed);
      })()`),
    );
    const starting = seeded.workspaces?.[0];
    const startingFolder = join(home, 'Marimo');
    if (
      seeded.workspaces?.length !== 1 ||
      starting?.path !== startingFolder ||
      starting?.name !== 'Marimo'
    ) {
      fail(
        `a fresh install did not start in a folder of its own: ${JSON.stringify(seeded)}`,
      );
    } else if (
      (await stat(startingFolder).catch(() => undefined))?.isDirectory() !== true
    ) {
      fail(`the starting folder was not created: ${startingFolder}`);
    } else {
      ok(`a fresh install starts in its own folder (${startingFolder})`);
    }

    /*
     * The first run, driven the way a person drives it.
     *
     * Checked here rather than further down because it is the first thing a new
     * user meets, and because it is the only part of the window no unit test can
     * reach: the steps, the fact that a fresh install offers no message box, and
     * the fact that finishing the flow produces one.
     *
     * Two things make the path completable without an account. The provider it
     * ends on is `Local llama.cpp`, which needs no key, and nothing is dialled
     * until a turn is sent. And the Space step is answered with its own primary
     * button — a fresh install now has a starting folder, so it offers
     * "Continue" rather than "Later"; a native picker cannot be driven from here
     * anyway, which is why choosing another folder is not part of this check.
     */
    const press = async (label) => {
      const find = `[...document.querySelectorAll('button')].find(
        (entry) => entry.textContent.trim() === ${JSON.stringify(label)} && !entry.disabled,
      )`;
      await until(`the "${label}" button`, async () =>
        (await evaluate(`(${find}) !== undefined`)) === true ? true : undefined,
      );
      const clicked = await evaluate(`(() => {
        const button = ${find};
        if (button === undefined) {
          return false;
        }
        button.click();
        return true;
      })()`);
      if (clicked !== true) {
        fail(`the "${label}" button went away before it could be pressed`);
      }
    };

    /*
     * A card's label is not its whole text: the path and starter cards carry a
     * blurb under the label, so an exact match finds nothing. This is for those,
     * and only those — a button whose whole text is the label should still use
     * `press` above.
     */
    const pressContaining = async (fragment) => {
      const find = `[...document.querySelectorAll('button')].find(
        (entry) => entry.textContent.includes(${JSON.stringify(fragment)}) && !entry.disabled,
      )`;
      await until(`a button containing "${fragment}"`, async () =>
        (await evaluate(`(${find}) !== undefined`)) === true ? true : undefined,
      );
      const clicked = await evaluate(`(() => {
        const button = ${find};
        if (button === undefined) {
          return false;
        }
        button.click();
        return true;
      })()`);
      if (clicked !== true) {
        fail(`the "${fragment}" button went away before it could be pressed`);
      }
    };

    const opened = JSON.parse(
      await evaluate(`JSON.stringify({
        flow: !!document.querySelector('.setup'),
        cta: document.querySelector('.onboarding .button-primary')?.textContent?.trim() ?? '',
        composer: !!document.querySelector('.composer-box'),
      })`),
    );
    if (opened.flow !== true || opened.cta !== 'Get started') {
      fail(
        `a fresh install did not open on the setup flow: ${JSON.stringify(opened)}`,
      );
    } else if (opened.composer !== false) {
      fail('the setup flow offered a message box before the app could answer');
    } else {
      ok('a fresh install opens on the setup flow, with nothing to type into');
    }

    await press('Get started');

    /*
     * The Provider step, now first. The local one, because it is the only entry
     * that can be chosen without an account — and choosing it is what makes the
     * app able to answer, which is what turns the step's own button on. The
     * guided bot path needs that, so the model cannot wait until the end.
     */
    const choseProvider = await evaluate(`(() => {
      const card = [...document.querySelectorAll('.capability-card')].find((entry) =>
        entry.textContent.trim().startsWith('Local llama.cpp'),
      );
      if (card === undefined) {
        return false;
      }
      card.click();
      return true;
    })()`);
    if (choseProvider !== true) {
      fail('the model step offers no local provider to choose');
    }
    await press('Continue');

    /*
     * The Space step. A fresh install has the starting folder the app created,
     * so the step answers with "Continue" and says which folder that is. That is
     * the check rather than pressing whatever happens to be primary: a step that
     * offered "Later" here would mean the seed did not happen.
     */
    const spaceLabels = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('.setup-body button')].map((entry) => entry.textContent.trim()))`,
      ),
    );
    if (!spaceLabels.includes('Continue')) {
      fail(
        `the Space step did not offer the starting folder to continue with: ${JSON.stringify(spaceLabels)}`,
      );
    } else {
      ok('the Space step offers the folder the app started in');
    }
    await press('Continue');

    /*
     * The bot step offers three doors. This check drives the form, because the
     * point of it is that a field draws, takes text and reaches the store; the
     * starter cards and the guided conversation have their own checks.
     */
    await pressContaining('Build it step by step');
    await until('the bot form', async () =>
      (await evaluate(
        `document.querySelector('.setup-form input.settings-input') !== null`,
      )) === true
        ? true
        : undefined,
    );
    const named = await evaluate(`(() => {
      const input = document.querySelector('.setup-form input.settings-input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'Smoke');
      input.dispatchEvent(new Event('input', {bubbles: true}));
      return input.value;
    })()`);
    if (named !== 'Smoke') {
      fail(`the bot's name field did not take a name: ${String(named)}`);
    }
    await press('Make this bot');

    /*
     * And the step that follows it: the Persona, which is the one piece of a
     * bot the person owns. Typed into the textarea and saved, because the
     * failure this catches is silent — a field that draws and never writes
     * leaves a bot with no Persona and nothing on screen to say so.
     */
    await until('the Persona step', async () =>
      (await evaluate(
        `document.querySelector('.setup-form textarea.settings-preferences') !== null`,
      )) === true
        ? true
        : undefined,
    );

    /*
     * The two things the Persona step shows beside the box: the Role it is
     * built on, greyed and read-only, and the shipped icons. Both are easy to
     * lose in a copy change, and neither failing raises anything by itself.
     */
    const personaExtras = JSON.parse(
      await evaluate(`JSON.stringify({
        role: document.querySelector('.setup-role-text')?.textContent?.trim().length ?? 0,
        icons: document.querySelectorAll('.settings-avatar-choice').length,
        back: [...document.querySelectorAll('.setup-body button')].some((entry) =>
          entry.textContent.trim() === 'Back'),
      })`),
    );
    if (personaExtras.role < 20) {
      fail('the Persona step does not show the Role it starts from');
    } else if (personaExtras.icons !== 5) {
      fail(`the Persona step shows ${String(personaExtras.icons)} icon choices, not five`);
    } else if (personaExtras.back !== true) {
      fail('the Persona step has no Back button');
    } else {
      ok('the Persona step shows the Role, the icons, and a way back');
    }

    /* Pick the wave icon, so the write is checked at the far end of the step. */
    const pickedIcon = await evaluate(`(() => {
      const button = document.querySelector('[data-avatar-id="wave"]');
      if (button === null) {
        return false;
      }
      button.click();
      return true;
    })()`);
    if (pickedIcon !== true) {
      fail('the Persona step offers no wave icon to choose');
    }
    const wrote = await evaluate(`(() => {
      const box = document.querySelector('.setup-form textarea.settings-preferences');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, 'The smoke test wrote this: be brief.');
      box.dispatchEvent(new Event('input', {bubbles: true}));
      return box.value;
    })()`);
    if (wrote !== 'The smoke test wrote this: be brief.') {
      fail(`the Persona box did not take text: ${String(wrote)}`);
    }
    await press('Save and continue');

    /* And the optional second half: one more bot, or none. */
    await press('That’s enough for now');

    /*
     * The recall offer, which is the flow's own last beat: the app went from
     * unable to answer to able while this window watched, and the one feature
     * that is invisible until it is used is offered exactly once at that moment.
     * Answered with "Not now", which is a real answer and the one that leaves the
     * rest of this script a plain, configured app.
     */
    await press('Not now');

    const afterSetup = JSON.parse(
      await evaluate(`(async () => {
        const {profiles} = await window.marimo.call('profiles.list', {});
        const {delegationTool} = await window.marimo.call('profiles.catalog', {});
        return JSON.stringify({
          flow: !!document.querySelector('.setup'),
          composer: !!document.querySelector('.composer-box'),
          bots: profiles.map((entry) => entry.name),
          botWords: profiles.find((entry) => entry.name === 'Smoke')?.persona ?? null,
          botIcon: profiles.find((entry) => entry.name === 'Smoke')?.avatar ?? null,
          leadTools: profiles[0]?.enabledTools ?? [],
          delegation: delegationTool ?? null,
          ready: (await window.marimo.call('settings.get', {})).settings.modelReady,
        });
      })()`),
    );
    if (afterSetup.flow !== false || afterSetup.composer !== true) {
      fail(
        `the setup flow did not close onto a chat: ${JSON.stringify(afterSetup)}`,
      );
    } else if (!afterSetup.bots.includes('Smoke')) {
      fail(
        `the bot made in the flow is not in the roster: ${afterSetup.bots.join(', ')}`,
      );
    } else if (
      afterSetup.botWords !== 'The smoke test wrote this: be brief.'
    ) {
      /*
       * The Persona the person wrote, at the far end of the path: the step, the
       * IPC call, the profile store, and back out of a payload the window reads.
       */
      fail(
        `the flow did not keep the Persona: ${JSON.stringify(afterSetup.botWords)}`,
      );
    } else if (
      afterSetup.delegation === null ||
      !afterSetup.leadTools.includes(afterSetup.delegation)
    ) {
      /*
       * The checkbox the step draws checked by default, asserted at the far end
       * of the path it travels: the name of the tool is the agent package's, and
       * the grant lands in the lead's profile.
       */
      fail(
        `the flow did not let Marimo Bot hand work to a bot: ${JSON.stringify(afterSetup)}`,
      );
    } else if (afterSetup.botIcon?.id !== 'wave') {
      /*
       * The icon chosen on the Persona step, read back from the store. The write
       * is immediate rather than part of the save, which is what makes it a
       * separate assertion from the Persona above.
       */
      fail(
        `the flow did not keep the chosen icon: ${JSON.stringify(afterSetup.botIcon)}`,
      );
    } else if (afterSetup.ready !== true) {
      fail('the flow closed without the app being able to answer');
    } else {
      ok(
        `the flow made a bot, kept how to talk to it, and closed onto a chat ` +
          `(${afterSetup.bots.join(', ')})`,
      );
    }

    /*
     * The rail, end to end.
     *
     * Folders are the part of the window no unit test can prove: the shape
     * travels schema → IPC → store → renderer, and a break anywhere along it
     * looks like a folder that simply never appears. The chat's own id in its
     * `…` menu is the other half, because that is what a bug report quotes.
     *
     * State is changed over the bridge and then read back from the DOM after a
     * reload. A window cannot be asked to re-read without one, and reloading is
     * what a second launch does anyway — so this is also the check that the two
     * lists survive a restart.
     */
    const secondFolder = join(userData, 'second-folder');
    await mkdir(secondFolder, {recursive: true});

    const activeRowId = async () =>
      await evaluate(`(() => {
        const row = document.querySelector('.rail-row[data-active="true"]');
        return row === null ? null : row.getAttribute('data-session-id');
      })()`);

    const chatId = await activeRowId();
    if (typeof chatId !== 'string' || chatId.length === 0) {
      fail('the rail does not list the open conversation under a folder');
    } else {
      ok(`the rail lists the open conversation (${chatId})`);
    }

    /*
     * The bots above the spaces, which is where a person switches whose
     * conversations they are looking at. One row has to be marked current, and
     * every row has a picture or the letter that stands in for one.
     */
    const botRail = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('.rail-bot')];
      return JSON.stringify({
        rows: rows.length,
        current: rows.filter((row) => row.getAttribute('aria-current') === 'true').length,
        icons: rows.filter((row) => row.querySelector('.bot-avatar') !== null).length,
        names: rows.map((row) => row.querySelector('.rail-bot-name')?.textContent ?? ''),
      });
    })()`);
    const bots = JSON.parse(botRail);
    if (bots.rows < 1) {
      fail('the rail draws no bots');
    } else if (bots.current !== 1) {
      fail(`the rail marks ${String(bots.current)} bots as current, not one`);
    } else if (bots.icons !== bots.rows) {
      fail('a bot in the rail has no icon or initial to draw');
    } else {
      ok(`the rail lists ${String(bots.rows)} bot(s): ${bots.names.join(', ')}`);
    }

    /*
     * The other door into making a bot: the `+` beside the Bots heading. It
     * opens the same dialog Settings does, over the conversation rather than in
     * place of it, and Escape has to put it away without creating anything.
     */
    const openedNewBot = await evaluate(`(() => {
      const button = document.querySelector('.rail-bots-new');
      if (button === null) {
        return false;
      }
      button.click();
      return true;
    })()`);
    if (openedNewBot !== true) {
      fail('the rail has no New bot button');
    }
    await until('the New bot dialog', async () =>
      (await evaluate(
        `document.querySelector('.new-bot-backdrop .new-bot') !== null`,
      )) === true
        ? true
        : undefined,
    );
    await evaluate(
      `window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`,
    );
    await until('the New bot dialog to close', async () =>
      (await evaluate(
        `document.querySelector('.new-bot-backdrop') === null`,
      )) === true
        ? true
        : undefined,
    );
    ok('the rail opens the New bot dialog and closes it with Escape');

    /*
     * A custom icon, served through the app's own scheme.
     *
     * The upload itself needs a native picker, which a smoke check cannot drive,
     * so this writes the one PNG the picker would have written and points the
     * profile at it. What it proves is the half that can break silently: the
     * renderer asks `marimo-asset://` for the picture, the main process serves
     * only the avatars directory, and the CSP allows the scheme. A failure here
     * shows as the letter fallback, which is otherwise a perfectly healthy rail.
     */
    const activeBotId = await evaluate(
      `window.marimo.call('profiles.list', {}).then(({activeProfileId}) => activeProfileId)`,
    );
    if (typeof activeBotId === 'string' && activeBotId.length > 0) {
      await mkdir(join(userData, 'avatars'), {recursive: true});
      await writeFile(
        join(userData, 'avatars', `${activeBotId.toLowerCase()}.png`),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=',
          'base64',
        ),
      );
      await evaluate(
        `window.marimo.call('profiles.update', ${JSON.stringify({
          profileId: activeBotId,
          patch: {avatar: {kind: 'custom', id: 'smoke'}},
        })})`,
      );
      await reload();
      const customAvatar = await until('the custom bot icon to load', async () =>
        await evaluate(`(() => {
          const image = document.querySelector(
            '.rail-bot[aria-current="true"] .bot-avatar img',
          );
          return image !== null && image.complete && image.naturalWidth > 0
            ? image.currentSrc
            : undefined;
        })()`),
      );
      if (!String(customAvatar).startsWith('marimo-asset://bot/')) {
        fail(`the custom bot icon did not load through the asset scheme: ${String(customAvatar)}`);
      } else {
        ok('a custom bot icon was served through marimo-asset');
      }
    }

    /*
     * The menu, opened the way a person opens it — a click on the row's `…`,
     * not a call to a handler.
     */
    await evaluate(
      `document.querySelector('.rail-row[data-active="true"] .rail-row-menu')?.click()`,
    );
    const menu = await until(
      'the conversation menu to open',
      async () =>
        await evaluate(`(() => {
        const menu = document.querySelector('.popover');
        if (menu === null) return undefined;
        const id = menu.querySelector('.popover-id code');
        return JSON.stringify({
          id: id === null ? null : id.textContent,
          copy: [...menu.querySelectorAll('button')].some((button) =>
            /copy/i.test(button.textContent ?? ''),
          ),
          actions: [...menu.querySelectorAll('.popover-item')].map(
            (item) => item.textContent ?? '',
          ),
        });
      })()`),
    );
    const shown = JSON.parse(menu);
    if (shown.id !== chatId) {
      fail(`the menu shows id ${shown.id} for a row filed as ${chatId}`);
    } else if (
      shown.copy !== true ||
      !shown.actions.includes('Rename…') ||
      !shown.actions.includes('Delete chat…')
    ) {
      fail(`the conversation menu is missing actions: ${menu}`);
    } else {
      ok(
        'the conversation menu shows its id, a copy button, rename and delete',
      );
    }
    // Escape closes it, and the check is that the listener is real rather than
    // that React re-rendered.
    await evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`,
    );
    if (
      (await evaluate(`document.querySelector('.popover') === null`)) !== true
    ) {
      fail('Escape did not close the conversation menu');
    } else {
      ok('Escape closes the conversation menu');
    }

    /*
     * Settle the window before moving anything.
     *
     * A conversation with no messages is listed only while it is the one on
     * screen, and the chat the window opened with is not necessarily the newest —
     * the probe created one too. Reloading makes boot land on the newest, so the
     * chat this check files is one that will still be visible afterwards.
     */
    await reload();
    const openId = await until(
      'the rail to settle on the newest chat',
      async () => {
        const id = await activeRowId();
        return typeof id === 'string' && id.length > 0 ? id : undefined;
      },
    );

    /*
     * Load a folder, rename it, file the open chat under it and rename the chat
     * — every one of those over the same bridge the window uses.
     */
    const changed = JSON.parse(
      await evaluate(`(async () => {
        const added = await window.marimo.call('workspaces.add', {
          path: ${JSON.stringify(secondFolder)},
        });
        const folder = added.workspaces.find(
          (entry) => entry.path === ${JSON.stringify(secondFolder)},
        );
        const renamed = await window.marimo.call('workspaces.rename', {
          workspaceId: folder.id,
          name: 'Smoke folder',
        });
        const {profiles, activeProfileId} = await window.marimo.call('profiles.list', {});
        const moved = await window.marimo.call('sessions.move', {
          profileId: activeProfileId,
          sessionId: ${JSON.stringify(openId)},
          workspaceId: folder.id,
        });
        const {session: retitled} = await window.marimo.call('sessions.rename', {
          profileId: activeProfileId,
          sessionId: ${JSON.stringify(openId)},
          title: 'Smoke chat',
        });
        return JSON.stringify({
          added: added.added,
          folderId: folder.id,
          named: renamed.workspaces.find((entry) => entry.id === folder.id)?.name,
          filed: moved.session.workspaceId,
          title: retitled.title,
          profileCount: profiles.length,
        });
      })()`),
    );
    if (
      changed.added !== true ||
      changed.named !== 'Smoke folder' ||
      changed.filed !== changed.folderId ||
      changed.title !== 'Smoke chat'
    ) {
      fail(`filing over the bridge did not take: ${JSON.stringify(changed)}`);
    } else {
      ok('a folder was loaded, renamed, and the chat filed under it');
    }

    // The reload is the restart: both lists are read again from disk. The wait
    // is for the *chat*, not for the folders: boot reads the folders first, so a
    // poll can see two of them a moment before the conversations arrive under
    // them — which is a window, not a failure.
    await reload();
    const rail = JSON.parse(
      await until('the rail to show the filed chat', async () => {
        const state = await evaluate(`(() => {
          const read = (row) => ({
            id: row.getAttribute('data-session-id'),
            title: row.querySelector('.rail-row-title')?.textContent ?? '',
          });
          const folders = [...document.querySelectorAll('.rail-workspace')];
          if (folders.length < 2) return undefined;
          const group = (label) => {
            const found = [...document.querySelectorAll('.rail-group')].find(
              (entry) => entry.querySelector('.rail-group-head')?.textContent === label,
            );
            return found === undefined
              ? []
              : [...found.querySelectorAll('.rail-row')].map(read);
          };
          return JSON.stringify({
            folders: folders.map((folder) => ({
              id: folder.getAttribute('data-workspace-id'),
              name: folder.querySelector('.rail-workspace-label')?.textContent ?? '',
              path: folder.querySelector('.rail-workspace-path')?.textContent ?? '',
              chats: [...folder.querySelectorAll('.rail-row')].map(read),
            })),
            social: group('Social'),
            otherChats: group('Other chats'),
          });
        })()`);
        if (state === undefined) {
          return undefined;
        }
        const parsed = JSON.parse(state);
        const filed = parsed.folders.some((folder) =>
          folder.chats.some((row) => row.id === openId),
        );
        return filed ? state : undefined;
      }),
    );
    const loaded = rail.folders.find(
      (folder) => folder.id === changed.folderId,
    );
    if (loaded === undefined) {
      fail('the folder that was loaded is not in the rail after a reload');
    } else if (
      loaded.name !== 'Smoke folder' ||
      !loaded.chats.some((row) => row.id === openId)
    ) {
      fail(
        `the chat was not filed under the loaded folder: ${JSON.stringify(loaded)}`,
      );
    } else if (
      loaded.chats.find((row) => row.id === openId)?.title !== 'Smoke chat'
    ) {
      fail('the renamed chat did not keep its name in the rail');
    } else {
      ok('the loaded folder and the filed chat survive a reload');
    }

    /*
     * Forgetting a folder. The chat has to move to "Other chats" rather than
     * vanish with it, and the directory has to be exactly where it was: "remove
     * from list" is what the menu promised.
     */
    const removed = JSON.parse(
      await evaluate(`(async () => {
        const state = await window.marimo.call('workspaces.remove', {
          workspaceId: ${JSON.stringify(changed.folderId)},
        });
        return JSON.stringify({
          removed: state.removed,
          stillListed: state.workspaces.some(
            (entry) => entry.id === ${JSON.stringify(changed.folderId)},
          ),
        });
      })()`),
    );
    if (removed.removed !== true || removed.stillListed !== false) {
      fail(`removing the folder did not take: ${JSON.stringify(removed)}`);
    }

    await reload();
    const after = JSON.parse(
      await until('the chat to move to Other chats', async () => {
        const state = await evaluate(`(() => {
          const folders = [...document.querySelectorAll('.rail-workspace')];
          if (folders.some((folder) =>
            folder.getAttribute('data-workspace-id') === ${JSON.stringify(changed.folderId)})) {
            return undefined;
          }
          return JSON.stringify({
            folderIds: folders.map((folder) => folder.getAttribute('data-workspace-id')),
            otherChats: [...document.querySelectorAll('.rail-group')].flatMap((group) =>
              group.querySelector('.rail-group-head')?.textContent === 'Other chats'
                ? [...group.querySelectorAll('.rail-row')].map((row) =>
                    row.getAttribute('data-session-id'),
                  )
                : [],
            ),
          });
        })()`);
        if (state === undefined) {
          return undefined;
        }
        // Both halves of the end state: the folder is gone *and* the chat that
        // was filed under it is reachable elsewhere. Waiting only for the first
        // would pass during the window before boot has read the conversations.
        return JSON.parse(state).otherChats.includes(openId)
          ? state
          : undefined;
      }),
    );
    if (after.folderIds.includes(changed.folderId)) {
      fail('the removed folder is still in the rail');
    } else if (!after.otherChats.includes(openId)) {
      fail(
        'the chat filed under the removed folder did not move to Other chats',
      );
    } else {
      ok('a forgotten folder takes its chats to Other chats');
    }

    if ((await stat(secondFolder).catch(() => undefined)) === undefined) {
      fail('removing a folder from the list deleted the directory');
    } else {
      ok('the folder itself was left exactly where it was');
    }

    if (probe.theme !== 'dark' && probe.theme !== 'light') {
      fail(`the theme attribute is "${probe.theme}", not light or dark`);
    } else {
      /*
       * A fresh data directory has no timer installed, so this is what the row
       * should say on a first run. It used to carry a second fact — whether a
       * stored key was one the runner could read — and that went with the key: a
       * background run needs no secret at all.
       */
      if (probe.serviceInstalled !== false) {
        fail(
          `the background-service row is wrong: installed=${String(probe.serviceInstalled)}`,
        );
      } else {
        ok(
          'the background-service row answered, and is off on a fresh install',
        );
      }

      /*
       * The scheduling tools are the specific ones that were unreachable, so they
       * are the specific ones asserted. A count alone would pass on a catalogue
       * that listed eleven read-only tools and nothing else.
       */
      const needed = [
        'read_file',
        'write_file',
        'run_shell',
        'create_job',
        'save_skill',
      ];
      const missing = needed.filter(
        (name) => !probe.catalogNames?.includes(name),
      );
      if (missing.length > 0 || probe.catalogBlurbs !== true) {
        fail(
          `the tool catalogue is incomplete: missing ${missing.join(', ') || '(none)'}` +
            `, blurbs ${String(probe.catalogBlurbs)}`,
        );
      } else {
        ok(
          `the tool catalogue offers ${String(probe.catalogNames?.length)} tools`,
        );
      }

      if (probe.skillsRoundTrip !== true) {
        fail('the skills editor did not reach the SKILL.md folder');
      } else {
        ok('a skill saves, lists and removes through the editor path');
      }

      /*
       * The companion window. Asserted from here rather than photographed: the
       * DevTools protocol cannot capture a transparent always-on-top window, so
       * the evidence that it is up and *transparent* comes from the page itself.
       */
      const pages = await (
        await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/list`)
      ).json();
      const pet = pages.find(
        (entry) =>
          entry.type === 'page' && entry.url.includes('companion.html'),
      );
      if (pet === undefined) {
        fail('the desktop companion window did not open');
      } else {
        const petSocket = new WebSocket(pet.webSocketDebuggerUrl);
        await new Promise((resolve) =>
          petSocket.addEventListener('open', resolve),
        );
        const answer = await new Promise((resolve) => {
          petSocket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id === 1) {
              resolve(message.result?.result?.value ?? '');
            }
          });
          petSocket.send(
            JSON.stringify({
              id: 1,
              method: 'Runtime.evaluate',
              params: {
                expression: `(() => {
                const moss = document.querySelector('.pet-moss');
                const bar = document.querySelector('.pet-input');
                const column = document.querySelector('.pet-column');
                return JSON.stringify({
                  moss: !!document.querySelector('.pet-moss img'),
                  input: !!bar,
                  transparent:
                    getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)',
                  /*
                   * The companion's shape, measured rather than assumed:
                   * answers, then the moss, then the bar. Geometry rather than
                   * DOM order, because what the user sees is where the boxes
                   * land — a stylesheet that stacked them the other way round
                   * would pass an order check and still put the bar in the way.
                   */
                  mossAboveBar:
                    moss !== null && bar !== null
                      ? moss.getBoundingClientRect().bottom <= bar.getBoundingClientRect().top
                      : false,
                  columnAboveMoss:
                    column !== null && moss !== null
                      ? column.getBoundingClientRect().bottom <= moss.getBoundingClientRect().top
                      : false,
                });
              })()`,
                returnByValue: true,
              },
            }),
          );
          setTimeout(() => {
            resolve('');
          }, 5_000);
        });
        const state = answer.length > 0 ? JSON.parse(answer) : {};
        if (
          state.moss !== true ||
          state.input !== true ||
          state.transparent !== true
        ) {
          fail(`the companion is wrong: ${answer}`);
        } else if (
          state.mossAboveBar !== true ||
          state.columnAboveMoss !== true
        ) {
          fail(`the companion's layout is out of order: ${answer}`);
        } else {
          ok(
            'the desktop companion is up, transparent, and shaped answers → moss → bar',
          );
        }

        /*
         * And now the thing that actually broke: does the pet *hear* the turn?
         *
         * The companion is not a decoration of the main window — it has no
         * transcript of its own to fall back on. Bubbles come from the event
         * stream, so a window that is broadcast to but not broadcast *at* looks
         * perfectly healthy and completely silent, while the same conversation
         * visibly progresses next door. Nothing about that is visible from the
         * main window, from the stores, or from any unit test: the pet's calls all
         * work, and only the answers were missing.
         *
         * A fresh install has no weights yet, so the honest expectation is not an
         * answer — it is a reaction. Sending from the pet must produce *something*
         * in the pet, and on this install that something is the refusal. Either
         * outcome passes; silence does not.
         */
        const reacted = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            resolve('timed out');
          }, 20_000);
          let step = 0;
          petSocket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            const value = message.result?.result?.value;
            if (message.id === 2) {
              // The send is away; give the turn a moment to be refused.
              setTimeout(() => {
                petSocket.send(
                  JSON.stringify({
                    id: 3,
                    method: 'Runtime.evaluate',
                    params: {
                      expression: `JSON.stringify({
                    bubbles: document.querySelectorAll('.pet-bubble').length,
                    error: !!document.querySelector('.pet-error'),
                    text: [...document.querySelectorAll('.pet-bubble')].map((b) => b.textContent).join(' ').slice(0, 80),
                  })`,
                      returnByValue: true,
                    },
                  }),
                );
              }, 6_000);
            }
            if (message.id === 3) {
              clearTimeout(timer);
              resolve(value ?? 'no value');
            }
          });
          // Type and press Enter the way a person does, through the real input.
          petSocket.send(
            JSON.stringify({
              id: 2,
              method: 'Runtime.evaluate',
              params: {
                expression: `(() => {
              const input = document.querySelector('.pet-input');
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, 'smoke: does the pet hear the answer?');
              input.dispatchEvent(new Event('input', {bubbles: true}));
              input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
              return 'sent';
            })()`,
                returnByValue: true,
              },
            }),
          );
        });
        if (reacted === 'timed out' || reacted === 'no value') {
          fail(`the companion never answered the check: ${reacted}`);
        } else {
          const seen = JSON.parse(reacted);
          if (seen.bubbles === 0 && seen.error !== true) {
            fail(
              'the companion received no events at all — it drew nothing after a ' +
                'turn was started from its own chat bar, which is what a window ' +
                'missing from broadcast() looks like',
            );
          } else {
            ok(
              `the companion hears the turn stream (${seen.text || 'shown as an error'})`,
            );
          }
        }
        petSocket.close();
      }

      /*
       * The composer's shape, which no unit test can see: this package has no DOM
       * test environment, and the two facts asserted here are the ones a
       * restructured composer gets wrong silently — the arrow belongs on the line
       * the message is typed on, and it is a circle. A Send that moved back to a
       * row of its own, or a labelled rectangle, would pass every other check.
       */
      const shape = await evaluate(`JSON.stringify((() => {
      const line = document.querySelector('.composer-line');
      const input = line?.querySelector('textarea.composer-input');
      const arrow = line?.querySelector('.composer-send');
      if (!line || !input || !arrow) {
        return {line: !!line, input: !!input, arrow: !!arrow};
      }
      const typed = input.getBoundingClientRect();
      const button = arrow.getBoundingClientRect();
      return {
        line: true,
        sameLine: button.top < typed.bottom && button.bottom > typed.top,
        round: Math.abs(button.width - button.height) < 1,
        label: arrow.getAttribute('aria-label'),
        glyph: arrow.textContent.trim(),
        foot: !!document.querySelector('.composer-foot'),
      };
    })())`);
      const composer = JSON.parse(shape);
      if (composer.line !== true || composer.foot !== true) {
        fail(`the composer lost its structure: ${shape}`);
      } else if (composer.sameLine !== true) {
        fail('the send button is not on the line the message is typed on');
      } else if (composer.round !== true) {
        fail('the send button is not a circle');
      } else if (composer.label !== 'Send message' || composer.glyph !== '↑') {
        fail(`the send button is not the arrow it should be: ${shape}`);
      } else {
        ok('the composer types and sends on one line, with a round arrow');
      }

      /*
       * The `+` menu: the things a message can carry that are not typed. Drawn by
       * the popover primitive the rail menus share, which is why a break here shows
       * up as a menu that never opens — and it has to open *upwards*, because the
       * control it belongs to sits at the bottom of the window.
       */
      await evaluate(`document.querySelector('.composer-add')?.click()`);
      const addMenu = await until('the + menu to open', async () => {
        const state = await evaluate(
          `(() => {
        const menu = document.querySelector('.popover');
        const plus = document.querySelector('.composer-add');
        if (menu === null || plus === null) return undefined;
        const box = menu.getBoundingClientRect();
        const anchor = plus.getBoundingClientRect();
        return JSON.stringify({
          items: [...menu.querySelectorAll('.popover-item')].map((item) =>
            item.textContent.trim(),
          ),
          above: box.bottom <= anchor.top + 1,
          /*
           * The rule the popover exists to keep: the menu is on screen. By the
           * time this runs the setup flow has closed, so the composer sits at the
           * bottom of the window with an empty transcript above it — the state
           * where there is no room below and the menu has to flip. What is
           * asserted is that it flipped exactly when it had to, rather than
           * always or never.
           */
          withinViewport: box.top >= 0 && box.bottom <= window.innerHeight,
          needsFlip:
            anchor.bottom + 4 + box.height + 8 > window.innerHeight,
          where: {
            menuBottom: Math.round(box.bottom),
            plusBottom: Math.round(anchor.bottom),
            viewport: window.innerHeight,
          },
        });
      })()`,
        );
        return state === undefined ? undefined : JSON.parse(state);
      });
      if (!addMenu.items.includes('Add files…')) {
        fail(
          `the + menu has no way to add a file: ${JSON.stringify(addMenu.items)}`,
        );
      } else if (!addMenu.items.includes('Compact history')) {
        /*
         * The command catalogue and the setting that switches one off travel
         * protocol → settings → this menu. An empty list here means one of those
         * three stopped agreeing with the others, which is invisible from every
         * unit test each of them passes on its own.
         */
        fail(`the + menu offers no commands: ${JSON.stringify(addMenu.items)}`);
      } else if (addMenu.withinViewport !== true) {
        fail(
          `the + menu is off the bottom of the window: ${JSON.stringify(addMenu.where)}`,
        );
      } else if (addMenu.needsFlip === true && addMenu.above !== true) {
        fail('the + menu did not flip above a trigger with no room below it');
      } else {
        ok(`the + menu opens on screen with: ${addMenu.items.join(', ')}`);
      }
      await evaluate(
        `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`,
      );
      if (
        (await evaluate(`document.querySelector('.popover') === null`)) !== true
      ) {
        fail('Escape did not close the + menu');
      }

      /*
       * The documents drawer, which is the other half of "a Space owns things":
       * the folder's files, listed and editable in the window. What is asserted
       * here is that the surface exists, opens, and that its left edge resizes
       * the column and remembers the width — the library's contents depend on
       * the folder a smoke run happens to have loaded, and the rules that matter
       * (the path guard, the revision conflict) are unit tests with a real
       * filesystem behind them.
       */
      const documents = await until('the documents button to appear', async () => {
        const value = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find(
            (entry) => (entry.textContent ?? '').trim() === 'Documents',
          );
          return button === undefined ? undefined : JSON.stringify({found: true});
        })()`);
        return value === undefined ? undefined : JSON.parse(value);
      });
      if (documents.found !== true) {
        fail('the window has no way into a space\u2019s documents');
      } else {
        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find(
            (entry) => (entry.textContent ?? '').trim() === 'Documents',
          );
          button?.click();
        })()`);
        const opened = await until('the drawer to open', async () => {
          const value = await evaluate(`(() => {
            const panel = document.querySelector('.documents');
            return panel === null
              ? undefined
              : JSON.stringify({open: true, text: (panel.textContent ?? '').slice(0, 400)});
          })()`);
          return value === undefined ? undefined : JSON.parse(value);
        });
        if (opened.open !== true) {
          fail('the documents drawer did not open');
        } else if (!/space|document/i.test(opened.text)) {
          fail(`the drawer says nothing about what it is: ${opened.text}`);
        } else {
          ok('the documents drawer opens onto the space it is about');
        }

        /*
         * The left edge, dragged with the pointer the same way the Role box is
         * below. `getBoundingClientRect` is in CSS pixels, which is also what
         * the Input domain takes.
         */
        const beforeResize = await evaluate(`(() => {
          const panel = document.querySelector('.documents');
          const handle = document.querySelector('.documents-resizer');
          if (panel === null || handle === null) return JSON.stringify({});
          const rect = handle.getBoundingClientRect();
          return JSON.stringify({
            width: panel.getBoundingClientRect().width,
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          });
        })()`);
        const startWidth = JSON.parse(beforeResize ?? '{}');
        if (
          typeof startWidth.width !== 'number' ||
          typeof startWidth.x !== 'number' ||
          typeof startWidth.y !== 'number'
        ) {
          fail('the documents drawer has no resize handle');
        } else {
          const target = startWidth.x - 60;
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: startWidth.x,
            y: startWidth.y,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          });
          /*
           * Two moves rather than a jump, for the reason the Role box drag has
           * two: a teleport with the button down can be read as a hover that
           * happens to end somewhere else.
           */
          for (const x of [startWidth.x - 20, target]) {
            await send('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x,
              y: startWidth.y,
              button: 'left',
              buttons: 1,
            });
          }
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: target,
            y: startWidth.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          });

          const widened = await until(
            'the documents drawer to widen',
            async () => {
              const width = await evaluate(
                `document.querySelector('.documents').getBoundingClientRect().width`,
              );
              return typeof width === 'number' && width > startWidth.width + 30
                ? width
                : undefined;
            },
          ).catch(() => undefined);
          if (widened === undefined) {
            fail(
              `the documents drawer did not widen from ${startWidth.width}px`,
            );
          } else {
            const remembered = await until(
              'the documents width to be remembered',
              async () => {
                const width = await evaluate(
                  `window.marimo.call('settings.get', {}).then(({settings}) => settings.documentsWidth)`,
                );
                return typeof width === 'number' &&
                  width > startWidth.width + 30
                  ? width
                  : undefined;
              },
            ).catch(() => undefined);
            if (remembered === undefined) {
              fail('the documents width was not written to settings');
            } else {
              ok(
                `the documents drawer resizes, and remembers ${String(remembered)}px`,
              );
            }
          }
        }

        await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')].find(
            (entry) => (entry.textContent ?? '').trim() === 'Documents',
          );
          button?.click();
        })()`);
      }


      /*
       * The compact command, run the way a person runs it.
       *
       * What this proves is the round trip: the `+` menu, the command, the IPC
       * call, the agent, and a sentence back in the composer's hint slot. By the
       * time it runs the setup flow has been through, so the app has a provider
       * and this is a conversation nothing has been said in — which makes the
       * agent's own answer the honest one: there is nothing to compact yet. That
       * arrives as a *note* rather than a failure, because a command that cannot
       * run is not a broken app.
       *
       * So the assertion is that something came back and that it is not the
       * sentence a broken path produces. Silence — a command that ran and said
       * nothing — times out here, and a missing handler arrives as "Unknown IPC
       * method", which the check below names rather than accepting.
       */
      await evaluate(`document.querySelector('.composer-add')?.click()`);
      await until(
        'the + menu to reopen',
        async () =>
          await evaluate(`document.querySelector('.popover') !== null`),
      );
      await evaluate(
        `[...document.querySelectorAll('.popover-item')]
        .find((item) => item.textContent.trim() === 'Compact history')?.click()`,
      );
      const reported = await until(
        'the compact command to report back',
        async () => {
          const text = await evaluate(
            `document.querySelector('.composer-hint')?.textContent ?? null`,
          );
          /*
           * Two sentences in that slot are not an answer to anything: what it
           * says while idle, and what it says while the command is running.
           */
          return typeof text === 'string' &&
            !/Enter to send|Working…/u.test(text)
            ? text
            : undefined;
        },
      );
      if (/unknown ipc method|no handler/iu.test(reported)) {
        fail(`the compact command never reached the agent: ${reported}`);
      } else {
        ok(
          `the compact command reached the agent and reported: ${reported.trim()}`,
        );
      }

      /*
       * Settings, opened the way a person opens it.
       *
       * Everything below reaches *into* this dialog: which sections each screen
       * draws, which controls the Model card has, and whether the app identity and
       * the preferences box are both there. A dialog that failed to open would
       * take all of that coverage with it and look like a pass.
       */
      await send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('.head button')]
        .find((entry) => entry.textContent.trim() === 'Settings')
        ?.click()`,
        returnByValue: true,
      });

      /*
       * One screen, and it holds the whole app.
       *
       * The old shape had a switch that decided which cards existed; a build
       * that removed the switch and forgot a card would still look like a
       * settings page. So the check looks for the absence of the switch *and*
       * for the presence of the sections that used to be behind it, plus the
       * icon controls that are new here.
       */
      const settingsScreen = await until('the settings sections', async () => {
        const value = await evaluate(`(() => {
        const sections = [...document.querySelectorAll('details.settings-section')];
        if (sections.length === 0) return undefined;
        return JSON.stringify({
          titles: sections.map((entry) => entry.querySelector('h3')?.textContent ?? ''),
          openOnArrival: sections.filter((entry) => entry.open).length,
          hasModeSwitch: document.querySelector('.settings-mode') !== null,
          capabilityCards: document.querySelectorAll('.capability-card').length,
          botRows: document.querySelectorAll('.settings-agent').length,
          avatarChoices: document.querySelectorAll('.settings-avatar-choice').length,
          density: document.documentElement.dataset.density ?? '',
        });
      })()`);
        return value === undefined ? undefined : JSON.parse(value);
      });

      if (settingsScreen.hasModeSwitch) {
        fail('the single settings screen still draws a simple/power switch');
      } else if (!settingsScreen.titles.includes('Provider')) {
        fail('the settings screen cannot reach the provider that answers for it');
      } else if (!settingsScreen.titles.includes('Connectors')) {
        fail('the settings screen cannot reach the connectors it has');
      } else if (!settingsScreen.titles.includes('Commands')) {
        fail('the settings screen does not draw the command switches');
      } else if (!settingsScreen.titles.some((title) => title.endsWith('can do'))) {
        fail('the settings screen does not draw the per-tool switches');
      } else if (settingsScreen.capabilityCards !== 0) {
        fail('the settings screen still draws the setup flow\'s capability cards');
      } else if (settingsScreen.botRows < 1) {
        fail('the settings screen draws no bot rows');
      } else if (settingsScreen.avatarChoices < 5) {
        fail(
          `the settings screen offers ${String(settingsScreen.avatarChoices)} icon choices, not five`,
        );
      } else if (settingsScreen.openOnArrival > 0) {
        fail('a fresh install opens with a settings section already expanded');
      } else if (settingsScreen.density !== 'comfortable') {
        fail(`the settings screen is drawn at density "${settingsScreen.density}"`);
      } else {
        ok(
          `settings is one screen: ${String(settingsScreen.titles.length)} sections, ` +
            `${String(settingsScreen.avatarChoices)} icon choices, no mode switch`,
        );
      }

      /**
       * Opens a section the way a person does — a click on its heading.
       *
       * Idempotent, because the fold is stored: the walk below comes back to the
       * Commands panel a second time and it is still open from the first visit.
       */
      const openSection = async (title) => {
        await evaluate(`(() => {
        const section = [...document.querySelectorAll('details.settings-section')]
          .find((entry) => entry.querySelector('h3')?.textContent === ${JSON.stringify(title)});
        if (section !== undefined && !section.open) {
          section.querySelector('summary')?.click();
        }
      })()`);
        const opened = await until(`the ${title} section to open`, async () => {
          const value = await evaluate(`(() => {
          const section = [...document.querySelectorAll('details.settings-section')]
            .find((entry) => entry.querySelector('h3')?.textContent === ${JSON.stringify(title)});
          return section === undefined ? undefined : section.open;
        })()`);
          return value === true ? true : undefined;
        });
        if (opened !== true) {
          fail(`the ${title} section could not be opened`);
        }
      };

      /*
       * The Provider card, which is the one thing here that decides whether the
       * app can answer at all.
       *
       * A window with no model of its own has three facts to get right and no way
       * for a unit test to see them together: the picker offers the catalogue in
       * its own order, the key field is a field rather than a value — invariant 8,
       * which is exactly the thing a renderer bug would leak — and Fetch Models
       * exists, because a service's list of models is not something this app can
       * know and a picker with no way to ask is a picker of yesterday's guesses.
       */
      await openSection('Provider');
      const providerCard = await until('the Provider card to answer', async () => {
        const state = await evaluate(`(() => {
          const section = [...document.querySelectorAll('.settings-section')]
            .find((entry) => entry.querySelector('h3')?.textContent === 'Provider');
          if (section === undefined) return undefined;
          const select = section.querySelector('select');
          const key = section.querySelector('input[type="password"]');
          return JSON.stringify({
            options: select === null
              ? null
              : [...select.options].map((option) => option.textContent ?? ''),
            selected: select === null ? null : select.value,
            keyField: key !== null,
            // The value, not the field: a password input that came back with a
            // stored secret in it is the failure this asserts against.
            keyValue: key === null ? null : key.value,
            buttons: [...section.querySelectorAll('button')].map(
              (button) => button.textContent ?? '',
            ),
          });
        })()`);
        return state === undefined ? undefined : JSON.parse(state);
      });

      if (providerCard.keyField !== true) {
        fail('the Provider card has no API-key field');
      } else if (providerCard.keyValue !== '') {
        // Invariant 8. The window is told whether a key is set, never what it is.
        fail('the Provider card drew a stored key back into the field');
      } else if (providerCard.options === null || providerCard.options.length < 5) {
        fail(
          `the Provider picker offers ${String(providerCard.options?.length)} services`,
        );
      } else if (!providerCard.options.join(' ').includes('llama.cpp')) {
        // The one entry that keeps a conversation on the machine. A catalogue
        // without it is a catalogue where nothing is private by default.
        fail('the Provider picker offers no server of your own');
      } else if (!providerCard.buttons.some((label) => /fetch/i.test(label))) {
        fail('the Provider card has no way to ask what a service serves');
      } else {
        ok('the Provider card offers the catalogue, no key value, and Fetch Models');
      }

      /*
       * The Learning card, which is the one inbox for everything the bot
       * proposes. A fresh install has nothing waiting, and the card still has
       * to draw: the outcome counts are what a proposal is judged against, and
       * an empty list with no counts is indistinguishable from a card that
       * failed to load.
       *
       * The Dream-RSI card is asserted *absent* in the same read. It was removed
       * with the feature, and a section that lingered would be a screen offering
       * a capability the build no longer has.
       */
      await openSection('Learning');
      const learningCard = await until('the Learning section to answer', async () => {
        const state = await evaluate(`(() => {
          const section = [...document.querySelectorAll('.settings-section')]
            .find((entry) => entry.querySelector('h3')?.textContent === 'Learning');
          if (section === undefined) return undefined;
          return JSON.stringify({
            text: section.textContent ?? '',
            stats: section.querySelectorAll('.learning-stats').length,
            dream: [...document.querySelectorAll('.settings-section')]
              .some((entry) => entry.querySelector('h3')?.textContent === 'Dream-RSI'),
          });
        })()`);
        return state === undefined ? undefined : JSON.parse(state);
      });

      if (!learningCard.text.includes('Waiting for you')) {
        fail('the Learning card has no inbox on it');
      } else if (learningCard.stats !== 1) {
        fail(
          `the Learning card draws ${String(learningCard.stats)} outcome rows, not one`,
        );
      } else if (learningCard.dream) {
        fail('the Dream-RSI card is still in Settings');
      } else {
        ok('the Learning card is there, with its outcome counts and one inbox');
      }

      /*
       * The two prompt boxes, asserted in the bundle the window actually loaded.
       * The Role is the app's text and the Persona is the person's, kept apart so
       * that the Role's Reset can restore one without touching the other — a
       * build that rendered one of them, or merged them back together, would pass
       * every unit test above and still be the wrong screen.
       */
      const prompts = await until(
        'the Role and Persona boxes to appear',
        async () => {
          const {result} = await send('Runtime.evaluate', {
            expression: `(() => {
            const section = [...document.querySelectorAll('.settings-section')]
              .find((entry) => entry.querySelector('h3')?.textContent === 'What it is');
            if (section === undefined) return undefined;
            const name = section.querySelector('input.settings-input');
            const role = section.querySelector('textarea[aria-label="Role"]');
            const persona = section.querySelector('textarea[aria-label="Persona"]');
            if (name === null || role === null || persona === null) {
              return JSON.stringify({incomplete: true});
            }
            return JSON.stringify({
              name: name.value,
              roleLength: role.value.length,
              persona: persona.value,
              placeholder: persona.placeholder,
              reset: [...section.querySelectorAll('button')].some(
                (entry) => entry.textContent.trim() === 'Reset to default',
              ),
            });
          })()`,
            returnByValue: true,
          });
          return typeof result?.value === 'string'
            ? JSON.parse(result.value)
            : undefined;
        },
      );

      if (prompts.incomplete === true) {
        fail('the "What it is" section is missing one of its boxes');
      } else if ((prompts.name ?? '').length === 0) {
        fail('the agent has no name in Settings');
      } else if (prompts.roleLength === 0) {
        fail('the Role box is empty on a fresh install');
      } else if (prompts.reset !== true) {
        fail('the Role box has no Reset to default button');
      } else if ((prompts.persona ?? '').length === 0) {
        fail('the Persona box is empty on a fresh install');
      } else if ((prompts.placeholder ?? '').length === 0) {
        // The example is how somebody works out what the box is for.
        fail('the Persona box has no example in it');
      } else {
        ok(
          'Settings carries the app Role, a Reset, and a seeded Persona',
        );
      }

      /*
       * The resize corner on that box, dragged with real pointer events.
       *
       * It was broken in a way nothing else could see. `.settings-input` sets
       * `flex: 1`, the field around it is a column, and a zero flex basis beats
       * the `height` property on that axis — so the corner faithfully wrote an
       * inline height, the layout ignored it, and the box never moved. Asserting
       * the computed `resize` or `flex-basis` would have passed throughout; only
       * a drag can tell the difference between a control that is enabled and one
       * that works.
       *
       * The corner is only used once the layout has settled and the point really
       * is over the box, which is what `grabbable` waits for. Opening the section
       * writes the fold to the settings file and re-reads it, so for a moment
       * after the click the panel is still moving: a corner measured then lands
       * somewhere else by the time the pointer arrives, which reads as a resizer
       * that does not work.
       */
      let identityBox;
      let lastLook;
      /*
       * Opened first, and that is not decoration. A closed `<details>` in this
       * Chromium keeps its children's geometry, so the corner of a box inside one
       * can be computed, measured and still not be painted or reachable — the
       * first version of this check dragged a box that was not on screen and read
       * as a resizer that does not work. The prompts check above reads the same
       * box without opening the section, which is how this stayed hidden.
       */
      await openSection('What it is');
      try {
        identityBox = await until('the Role box to be draggable', async () => {
          const state = await evaluate(`(() => {
          const box = document.querySelector('textarea.settings-identity');
          if (box === null) return undefined;
          box.scrollIntoView({block: 'start'});
          const rect = box.getBoundingClientRect();
          /*
           * A few pixels in from the corner, tried outward. The corner itself is
           * rounded, so the last pixel or two of the box is not painted and a hit
           * test there lands on the section behind it.
           */
          const hits = [3, 6, 9, 12].map((inset) => {
            const x = rect.right - inset;
            const y = rect.bottom - inset;
            const element = document.elementFromPoint(x, y);
            return {
              inset,
              x,
              y,
              onBox: element === box,
              found: element === null
                ? 'none'
                : element.tagName + '.' + element.className,
            };
          });
          const grabbable = hits.find((hit) => hit.onBox === true);
          return JSON.stringify({
            height: rect.height,
            room: window.innerHeight - rect.bottom,
            hits,
            ...(grabbable === undefined
              ? {}
              : {x: grabbable.x, y: grabbable.y}),
            ready:
              grabbable !== undefined &&
              window.innerHeight - rect.bottom > 150,
          });
        })()`);
          if (state === undefined) {
            return undefined;
          }
          const parsed = JSON.parse(state);
          lastLook = parsed;
          return parsed.ready === true ? parsed : undefined;
        });
      } catch {
        identityBox = undefined;
      }

      if (identityBox === undefined) {
        fail(
          'the Role box could not be put in reach of the pointer: ' +
            `${JSON.stringify(lastLook)}`,
        );
      } else {
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: identityBox.x,
          y: identityBox.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        /*
         * Two moves rather than one jump, and `buttons: 1` on both: a resizer is
         * a drag, and a single teleport with the button state unset can be read
         * as a hover that happens to end where the pointer was put.
         */
        for (const distance of [40, 120]) {
          await send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: identityBox.x,
            y: identityBox.y + distance,
            button: 'left',
            buttons: 1,
          });
        }
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: identityBox.x,
          y: identityBox.y + 120,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });

        const grew = await until('the Role box to resize', async () => {
          const {result} = await send('Runtime.evaluate', {
            expression:
              'document.querySelector("textarea.settings-identity")' +
              '.getBoundingClientRect().height',
            returnByValue: true,
          });
          const height = result?.value;
          return typeof height === 'number' && height > identityBox.height + 40
            ? true
            : undefined;
        }).catch(() => false);

        if (grew !== true) {
          fail(
            `the Role box did not resize when its corner was dragged ` +
              `(still ${String(identityBox.height)}px tall; hit tests ` +
              `${JSON.stringify(identityBox.hits)})`,
          );
        } else {
          ok('the Role box resizes when its corner is dragged');
        }
      }

      /*
       * A command switched off in Settings is *absent* from the composer's menu
       * rather than merely discouraged there — the rule the whole capability model
       * rests on, and the one that cannot be checked from either side alone: the
       * switch writes the settings file and the menu reads it, in two processes
       * and three layers apart.
       */
      const switched = await until(
        'the Commands section to answer',
        async () => {
          const state = await evaluate(`(() => {
        const section = [...document.querySelectorAll('.settings-section')]
          .find((entry) => entry.querySelector('h3')?.textContent === 'Commands');
        if (!section) return undefined;
        const box = section.querySelector('input[type="checkbox"]');
        const label = section.querySelector('.settings-check span')?.textContent ?? '';
        return JSON.stringify({found: true, checked: box?.checked, label});
      })()`);
          return state === undefined ? undefined : JSON.parse(state);
        },
      );
      if (switched.checked !== true) {
        fail(
          `a fresh install has the command switched off: ${JSON.stringify(switched)}`,
        );
      } else if (!/Compact history/u.test(switched.label)) {
        fail(`the Commands section names the wrong thing: ${switched.label}`);
      } else {
        await openSection('Commands');
        await evaluate(
          `(() => {
          const section = [...document.querySelectorAll('.settings-section')]
            .find((entry) => entry.querySelector('h3')?.textContent === 'Commands');
          section?.querySelector('input[type="checkbox"]')?.click();
        })()`,
        );
        const off = await until('the switch to take', async () => {
          const value = await evaluate(`(() => {
          const section = [...document.querySelectorAll('.settings-section')]
            .find((entry) => entry.querySelector('h3')?.textContent === 'Commands');
          const box = section?.querySelector('input[type="checkbox"]');
          return box === null || box === undefined ? undefined : !box.checked;
        })()`);
          return value === true ? true : undefined;
        });
        if (off !== true) {
          fail('switching a command off in Settings did not take');
        } else {
          // Back to the chat, where the menu either offers it or does not.
          await evaluate(
            `[...document.querySelectorAll('.settings-head button')]
            .find((entry) => entry.textContent.trim() === 'Back to chat')?.click()`,
          );
          await until(
            'the composer to come back',
            async () =>
              await evaluate(
                `document.querySelector('.composer-add') !== null`,
              ),
          );
          await evaluate(`document.querySelector('.composer-add')?.click()`);
          const items = await until('the + menu to open', async () => {
            const value = await evaluate(`(() => {
            const menu = document.querySelector('.popover');
            return menu === null
              ? undefined
              : JSON.stringify(
                  [...menu.querySelectorAll('.popover-item')].map((item) =>
                    item.textContent.trim(),
                  ),
                );
          })()`);
            return value === undefined ? undefined : JSON.parse(value);
          });
          await evaluate(
            `document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}))`,
          );
          if (items.includes('Compact history')) {
            fail('a command switched off in Settings is still in the + menu');
          } else if (!items.includes('Add files…')) {
            fail('switching a command off took the other items with it');
          } else {
            ok('a command switched off in Settings is gone from the + menu');
          }
          // Put it back: the checks after this one expect a fresh install.
          await evaluate(
            `[...document.querySelectorAll('.head button')]
            .find((entry) => entry.textContent.trim() === 'Settings')?.click()`,
          );
          const reopen = await until(
            'the Commands section to come back',
            async () => {
              const state = await evaluate(`(() => {
            const section = [...document.querySelectorAll('.settings-section')]
              .find((entry) => entry.querySelector('h3')?.textContent === 'Commands');
            if (!section) return undefined;
            const box = section.querySelector('input[type="checkbox"]');
            return JSON.stringify({present: true, checked: box?.checked});
          })()`);
              return state === undefined ? undefined : JSON.parse(state);
            },
          );
          // Still open from the visit above, but said again: this is the gesture a
          // person makes after reopening the dialog, whatever the file remembers.
          await openSection('Commands');
          await evaluate(
            `(() => {
            const section = [...document.querySelectorAll('.settings-section')]
              .find((entry) => entry.querySelector('h3')?.textContent === 'Commands');
            section?.querySelector('input[type="checkbox"]')?.click();
          })()`,
          );
          const restored = await until(
            'the command to be switched back on',
            async () => {
              /*
               * `undefined` until it is actually back on: `until` resolves on the
               * first non-undefined answer, and a state returned the moment the box
               * was clicked is a state read while the write is still in flight — the
               * box is disabled and still shows the old value until the pane has
               * re-read the settings.
               */
              const state = await evaluate(`(() => {
            const section = [...document.querySelectorAll('.settings-section')]
              .find((entry) => entry.querySelector('h3')?.textContent === 'Commands');
            if (!section) return undefined;
            const box = section.querySelector('input[type="checkbox"]');
            return JSON.stringify({checked: box?.checked, saving: box?.disabled});
          })()`);
              if (state === undefined) {
                return undefined;
              }
              const parsed = JSON.parse(state);
              return parsed.checked === true ? parsed : undefined;
            },
          );
          if (restored.checked !== true) {
            fail(
              `the command could not be switched back on: after reopening it was ` +
                `${JSON.stringify(reopen)}, now ${JSON.stringify(restored)}`,
            );
          }
        }
      }

      /*
       * The reset card, everything about it short of the press — the press
       * itself is the last thing this check does, once there is nothing left to
       * measure afterwards.
       *
       * Pressing it here would empty this throwaway directory and quit the app in
       * the middle of the walk, so what is checked is what makes the press safe:
       * the card is there and is the last one, it is drawn in the one colour that
       * means destruction on this screen, its button is dead on arrival, and only
       * the phrase — the one the built bundle draws, since the label and the check
       * share a constant — arms it. A button that was born armed, or one that took
       * a prefix of the words, is a factory reset nobody asked for.
       */
      await openSection('Reset Marimo Bot');
      const resetCard = await until('the reset card to answer', async () => {
        const state = await evaluate(`(() => {
        const sections = [...document.querySelectorAll('details.settings-section')];
        const section = sections.find(
          (entry) => entry.querySelector('h3')?.textContent === 'Reset Marimo Bot',
        );
        if (section === undefined) return undefined;
        const button = section.querySelector('button.button-danger');
        return JSON.stringify({
          last: sections[sections.length - 1] === section,
          danger: section.classList.contains('settings-section-danger'),
          label: button?.textContent.trim() ?? '',
          disabled: button?.disabled ?? null,
        });
      })()`);
        return state === undefined ? undefined : JSON.parse(state);
      });

      /** Types into the real field, through the real setter. */
      const typeResetPhrase = async (value) =>
        await evaluate(`(() => {
        const section = [...document.querySelectorAll('.settings-section')]
          .find((entry) => entry.querySelector('h3')?.textContent === 'Reset Marimo Bot');
        const input = section.querySelector('input.settings-input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', {bubbles: true}));
        return input.value;
      })()`);

      /** Whether the button is armed, once React has had a frame to redraw. */
      const resetArmed = async () =>
        await until('the reset button to answer', async () => {
          const value = await evaluate(`(() => {
          const section = [...document.querySelectorAll('.settings-section')]
            .find((entry) => entry.querySelector('h3')?.textContent === 'Reset Marimo Bot');
          const button = section?.querySelector('button.button-danger');
          return button === null || button === undefined ? undefined : !button.disabled;
        })()`);
          return value === undefined ? undefined : value;
        });

      if (resetCard.last !== true) {
        fail('the reset card is not the last one on the settings screen');
      } else if (resetCard.danger !== true) {
        fail('the reset card is not drawn as the dangerous one');
      } else if (resetCard.disabled !== true) {
        fail('the reset button is armed before anybody has typed anything');
      } else if (!/Erase everything and quit/u.test(resetCard.label)) {
        fail(`the reset button says: ${resetCard.label}`);
      } else {
        await typeResetPhrase('reset');
        const partial = await resetArmed();
        await typeResetPhrase('Reset Everything ');
        const armed = await resetArmed();
        // Left as it arrived: every check after this one expects a fresh install.
        await typeResetPhrase('');

        if (partial !== false) {
          fail('the reset button arms on part of the phrase');
        } else if (armed !== true) {
          fail('the reset button did not arm on the phrase');
        } else {
          ok(
            'the reset is last, drawn as the dangerous one, and armed only by ' +
              'its phrase',
          );
        }
      }

      /*
       * Removing a bot, through the menu a person uses: the row's `…`, the item,
       * and the second press that is the confirmation.
       *
       * It is the only action in the window that destroys more than one document
       * at once — the bot, its conversations, its schedule and what it remembered
       * — so what is checked is not only that it goes, but that its conversation
       * went with it and that the bot beside it is still there. A removal that
       * took a neighbour's history would otherwise be invisible until somebody
       * noticed a chat was missing.
       */
      await evaluate(
        `[...document.querySelectorAll('.settings-head button')]
        .find((entry) => entry.textContent.trim() === 'Back to chat')?.click()`,
      );
      const doomed = JSON.parse(
        await evaluate(`(async () => {
        const created = await window.marimo.call('profiles.create', {draft: {name: 'Doomed'}});
        const {session} = await window.marimo.call('sessions.create', {
          profileId: created.activeProfileId,
        });
        return JSON.stringify({id: created.activeProfileId, sessionId: session.id});
      })()`),
      );
      /*
       * Reopened rather than poked at: the list is read when the dialog mounts,
       * and a write made over the bridge is not one this component hears about.
       */
      await evaluate(
        `[...document.querySelectorAll('.head button')]
        .find((entry) => entry.textContent.trim() === 'Settings')?.click()`,
      );
      await until('the reopened bot list', async () =>
        (await evaluate(
          `document.querySelector('[aria-label="Actions for Doomed"]') !== null`,
        )) === true
          ? true
          : undefined,
      );
      await openSection('Your bots');
      await evaluate(
        `document.querySelector('[aria-label="Actions for Doomed"]')?.click()`,
      );
      const botMenu = await until('the bot menu', async () => {
        const value = await evaluate(`(() => {
        const menu = document.querySelector('.popover');
        return menu === null
          ? undefined
          : JSON.stringify(
              [...menu.querySelectorAll('.popover-item')].map((item) =>
                item.textContent.trim(),
              ),
            );
      })()`);
        return value === undefined ? undefined : JSON.parse(value);
      });
      await evaluate(
        `[...document.querySelectorAll('.popover-item')]
        .find((item) => item.textContent.trim() === 'Remove bot…')?.click()`,
      );
      const question = await until(
        'the removal question',
        async () =>
          await evaluate(
            `document.querySelector('.popover-confirm p')?.textContent ?? undefined`,
          ),
      );
      await evaluate(
        `[...document.querySelectorAll('.popover-confirm button')]
        .find((item) => item.textContent.trim() === 'Remove')?.click()`,
      );
      const afterRemoval = await until('the bot to go', async () => {
        const value = await evaluate(`(async () => {
        const {profiles} = await window.marimo.call('profiles.list', {});
        const {sessions} = await window.marimo.call('sessions.list', {
          profileId: ${JSON.stringify(doomed.id)},
        });
        return JSON.stringify({
          names: profiles.map((entry) => entry.name),
          sessions: sessions.length,
          row: document.querySelector('[aria-label="Actions for Doomed"]') !== null,
        });
      })()`);
        const parsed = value === undefined ? undefined : JSON.parse(value);
        return parsed !== undefined && parsed.row === false ? parsed : undefined;
      });

      if (!botMenu.includes('Rename…') || !botMenu.includes('Remove bot…')) {
        fail(`a bot's menu is missing its actions: ${JSON.stringify(botMenu)}`);
      } else if (!/Doomed/u.test(question ?? '')) {
        fail(`the removal question does not name the bot: ${String(question)}`);
      } else if (afterRemoval.names.includes('Doomed')) {
        fail(`a removed bot is still listed: ${JSON.stringify(afterRemoval)}`);
      } else if (afterRemoval.sessions !== 0) {
        fail(
          `a removed bot kept ${String(afterRemoval.sessions)} conversation(s)`,
        );
      } else if (afterRemoval.names.length === 0) {
        fail('removing a bot took the whole list with it');
      } else {
        ok('a bot was removed through its menu, conversations and all');
      }

      /*
       * Back to the chat before anything else is measured. The dialog covers the
       * window, and every check after this one — and the screenshot — is about the
       * window.
       */
      await send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('.settings-head button')]
        .find((entry) => entry.textContent.trim() === 'Back to chat')
        ?.click()`,
        returnByValue: true,
      });

      ok(`the theme resolved to ${probe.theme}`);
    }

    if (probe.userData !== userData) {
      fail(
        `the app is using ${probe.userData} but the check gave it ${userData} — ` +
          'the isolated directory did not take effect',
      );
    } else {
      ok('the app honoured the throwaway user-data directory');
    }

    if (wantedTheme !== undefined) {
      const clicked = await send('Runtime.evaluate', {
        expression: `(() => {
          const wanted = ${JSON.stringify(wantedTheme)};
          const button = [...document.querySelectorAll('.theme-button')]
            .find((entry) => entry.textContent.trim().toLowerCase() === wanted);
          if (button === undefined) return false;
          button.click();
          return true;
        })()`,
        returnByValue: true,
      });

      if (clicked.result?.value !== true) {
        fail(`there is no "${wantedTheme}" control to switch to`);
      } else {
        await until(`the theme to become ${wantedTheme}`, async () => {
          const {result} = await send('Runtime.evaluate', {
            expression: 'document.documentElement.dataset.theme',
            returnByValue: true,
          });
          return result?.value === wantedTheme ? true : undefined;
        });
        ok(`switched to the ${wantedTheme} theme`);
      }
    }

    /*
     * The renderer's own complaints. Printed on every run rather than only on
     * failure: a React warning or a rejected call that the checks happen not to
     * assert on is still something somebody needs to see.
     */
    const complaints = pageConsole.filter((line) =>
      /^(error|warning|assert)/u.test(line),
    );
    if (complaints.length > 0) {
      console.log('--- renderer ---');
      for (const line of complaints.slice(-20)) {
        console.log(`  ${line}`);
      }
    }

    if (shotFile !== undefined) {
      /*
       * A screenshot is a bonus, not the assertion. It needs a compositor that
       * can hand back a frame, which a headless or GPU-less machine may refuse —
       * `webContents.capturePage` does exactly that — and failing to take a
       * picture is not evidence that the window is broken.
       */
      try {
        const {data} = await send('Page.captureScreenshot', {format: 'png'});
        await writeFile(shotFile, Buffer.from(data, 'base64'));
        ok(`wrote a screenshot to ${shotFile}`);
      } catch (error) {
        console.warn(`! could not take a screenshot: ${error.message}`);
      }
    }

    /*
     * And last, the reset itself — pressed, this time, because everything else
     * has been checked and this is the one action whose outcome is the app
     * ending.
     *
     * It has to be the last thing for that reason, and it is here rather than in
     * the walk above because it takes the window with it. What it proves is the
     * pair nothing else can: the folder is emptied **and nothing is left
     * running**. The first version of this feature relaunched the app when it
     * was done, which left a fresh install sitting in the tray and read as a
     * reset that had not happened; a check asserting only that the folder was
     * empty passed the whole time. So the marker is one half and the process is
     * the other, and asking `appIsRunning` rather than `stopApp` is what makes
     * the second half an observation instead of a gesture.
     */
    await writeFile(
      join(userData, 'smoke-reset-marker.txt'),
      'seeded before the reset',
      'utf8',
    );
    await evaluate(
      `void window.marimo.call('app.reset', {}).catch(() => undefined)`,
    ).catch(() => undefined);
    await until('the reset to empty the user-data directory', async () =>
      (await readdir(userData)).includes('smoke-reset-marker.txt')
        ? undefined
        : true,
    );
    const quit = await until('the app to quit', async () =>
      appIsRunning() ? undefined : true,
    );
    if (quit !== true) {
      fail('the reset emptied the folder and left the app running');
    } else {
      ok('the reset emptied the user-data directory and quit the app');
    }
  } catch (error) {
    fail(error.message);
    const output = log.join('').trim();
    if (output.length > 0) {
      console.error('\n--- app output ---\n' + output.slice(-4_000));
    }
  } finally {
    socket?.close();
    if (!(await stopApp())) {
      fail('the app could not be stopped, and is still running');
    }
    await rm(userData, {recursive: true, force: true});
  }
}

/**
 * Wraps the socket in a request/response `send`.
 *
 * DevTools has no correlation beyond the id the client invents, so the pending
 * map is the whole of the protocol handling this check needs.
 *
 * The same socket carries the page's own console output, which is collected
 * rather than ignored: when a check fails, the renderer's complaint is usually
 * the only thing that says why, and it is not visible from the main process.
 */
async function attach(socket) {
  let nextId = 1;
  const pending = new Map();
  const console = [];

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.method === 'Runtime.consoleAPICalled') {
      const level = message.params?.type ?? 'log';
      const text = (message.params?.args ?? [])
        .map((arg) => arg?.value ?? arg?.description ?? '')
        .join(' ');
      if (text.length > 0) {
        console.push(`${level}: ${text}`);
      }
      return;
    }

    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message));
    } else {
      entry.resolve(message.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, {resolve, reject});
      socket.send(JSON.stringify({id, method, params}));
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`${method} did not answer within 10s`));
        }
      }, 10_000);
    });

  // Asks for the console stream before anything else, so a complaint made
  // during startup is not missed by being early.
  await send('Runtime.enable');

  return {send, console};
}

/**
 * Runs inside the page, over the same bridge the app uses.
 *
 * `mounted` is the gate: it is only true once the bridge answered *and* React
 * rendered. Anything else is a partial start that would otherwise pass.
 *
 * It goes past `app.info` on purpose. That call proves the preload is loaded; it
 * says nothing about whether the agent behind it came up. Asking for the agents
 * and starting a conversation is what proves the whole spine — the runtime, the
 * stores, and the IPC handlers — is connected, and it does it without needing a
 * model, because a conversation is a file and does not require one.
 */
const PROBE = `(async () => {
  const result = {
    hasBridge: typeof window.marimo === 'object' && window.marimo !== null,
    mounted: false,
    title: document.title,
    /*
     * Read at the end, not here. The theme is written by an effect after the
     * first paint, so a value captured before the bridge calls below can be null
     * on a machine that was slow enough for the probe to win the race. The
     * assertion is about the window once it is up, and that is when this is read.
     */
    theme: null,
    rootChildren: document.getElementById('root')?.childElementCount ?? 0,
  };
  if (!result.hasBridge) {
    return result;
  }
  try {
    const info = await window.marimo.call('app.info', {});
    result.product = info.name;
    result.version = info.version;
    result.userData = info.userData;

    const {profiles, activeProfileId} = await window.marimo.call('profiles.list', {});
    result.profileCount = profiles.length;
    result.activeProfileId = activeProfileId;

    const {session} = await window.marimo.call('sessions.create', {
      profileId: activeProfileId,
    });
    result.sessionId = session.id;

    const {sessions} = await window.marimo.call('sessions.list', {
      profileId: activeProfileId,
    });
    result.sessionCount = sessions.length;
    result.listedIds = sessions.map((entry) => entry.id);

    /*
     * The background-service row. Asked here rather than only photographed: the
     * switch is the one control in the window that reaches outside the app's own
     * files, and a call that threw would leave a row that silently never appears.
     */
    const service = await window.marimo.call('service.status', {});
    result.serviceInstalled = service.installed;

    /*
     * The catalogue the settings screen draws. Asserted because a tool the host
     * builds but the catalogue omits is a capability that exists and cannot be
     * granted: the switch for it does not exist. That happened — the scheduling
     * tools were missing — and it is invisible from the chat window.
     */
    const catalog = await window.marimo.call('profiles.catalog', {});
    result.catalogNames = catalog.tools.map((tool) => tool.name);
    result.catalogBlurbs = catalog.tools.every(
      (tool) => typeof tool.blurb === 'string' && tool.blurb.length > 0,
    );

    /*
     * The skills round trip. The store, its parsing and the editor have unit
     * tests; what they cannot prove is that the running app wired the store at
     * all. This saves one through the same IPC the card uses, checks it is
     * listed, and removes it again — the temp user data is thrown away either
     * way, and leaving it would make the next install's first read non-empty.
     */
    const {skills: beforeSkills} = await window.marimo.call('skills.list', {});
    const savedSkills = await window.marimo.call('skills.save', {
      draft: {
        name: 'smoke-procedure',
        description: 'A procedure the smoke check writes and removes.',
        instructions: '1. Prove the editor reaches the folder.',
      },
    });
    const removedSkills = await window.marimo.call('skills.remove', {
      id: 'smoke-procedure',
    });
    result.skillsRoundTrip =
      beforeSkills.length === 0 &&
      savedSkills.skills.some((skill) => skill.name === 'smoke-procedure') &&
      removedSkills.skills.every((skill) => skill.name !== 'smoke-procedure');

    const {messages, pending} = await window.marimo.call('sessions.get', {
      profileId: activeProfileId,
      sessionId: session.id,
    });
    result.messageCount = messages.length;
    result.pendingCount = pending.length;
  } catch (error) {
    result.error = String(error && error.message ? error.message : error);
    return result;
  }
  result.mounted = result.rootChildren > 0;
  result.theme = document.documentElement.dataset.theme ?? null;
  return result;
})()`;

await main();
