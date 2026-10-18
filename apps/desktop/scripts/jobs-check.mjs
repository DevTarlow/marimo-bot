/**
 * One-off verification: does a due job actually run in the app?
 *
 * Seeds a profile and a job that came due five minutes ago, launches the real
 * app against that directory, and reads back what the scheduler recorded.
 *
 * Not part of the test suite: it drives Electron, so it is a check to run by
 * hand when the job path changes rather than something for every commit.
 *
 * What it proves is the whole 24/7 path at once, which no unit test does: that
 * the scheduler starts with the app, notices a job that came due while nothing
 * was running, dispatches it, gives it a conversation of its own, runs a real
 * turn, and writes the outcome back — including when that outcome is a refusal.
 * A checkout has no weights in it, so the expected result here is exactly what it
 * prints: the job recorded as an error saying the model is not installed, rather
 * than silence.
 */
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {startApp, stopApp} from './app-process.mjs';

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(dirname(appRoot));
const {ProfileStore, resolveAppPaths} = await import(
  join(repo, 'packages', 'runtime', 'dist', 'index.js')
);

const dir = await mkdtemp(join(tmpdir(), 'marimo-jobs-'));
/*
 * A home of the check's own. The runner seeds — and creates — the starting Space
 * under the home directory when it makes the job's conversation, so leaving HOME
 * alone would put a `Marimo` folder in the real home of whoever ran the check.
 */
const home = join(dir, 'home');
await mkdir(home, {recursive: true});
const paths = resolveAppPaths(dir);

const profiles = new ProfileStore({
  file: paths.profiles,
  defaultWorkspaceRoot: dir,
  defaultIdentity: '',
  botIdentity: () => '',
  defaultTools: [],
  defaultSkills: [],
});
await profiles.load();
const profile = await profiles.activeProfile();
console.log('profile:', profile.id);

const dueAt = new Date(Date.now() - 5 * 60_000).toISOString();
await writeFile(
  paths.jobs,
  JSON.stringify(
    {
      version: 1,
      jobs: {
        jobs: [
          {
            id: 'job-1',
            name: 'Overnight summary',
            description: 'Say hello.',
            schedules: ['0 9 * * *'],
            enabled: true,
            profileId: profile.id,
            sessionId: null,
            createdAt: new Date().toISOString(),
            dueAt,
          },
        ],
        open: false,
        openJobId: null,
      },
    },
    null,
    2,
  ),
);

const child = startApp({
  command: './node_modules/.bin/electron',
  args: ['.', '--no-sandbox'],
  cwd: appRoot,
  env: {
    ...process.env,
    MARIMO_USER_DATA_DIR: dir,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(repo, '.xdg-cache'),
  },
});
let out = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  out += chunk;
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  out += chunk;
});

await wait(7000);
/*
 * Waited for, not fired and forgotten, and that is what makes the read below
 * mean anything: the app holds its quit while it stops the agent, and a job it
 * was midway through recording would otherwise be read as one it never ran.
 */
if (!(await stopApp())) {
  console.error('the app could not be stopped, and is still running');
  process.exitCode = 1;
}

const after = JSON.parse(await readFile(paths.jobs, 'utf8'));
const job = after.jobs.jobs[0];
console.log('\n--- the job after the app ran ---');
console.log('lastStatus:', job.lastStatus);
console.log('lastError: ', (job.lastError ?? '(none)').slice(0, 140));
console.log('sessionId: ', job.sessionId);
console.log('occurrence consumed:', job.dueAt !== dueAt);

try {
  const index = JSON.parse(
    await readFile(join(dir, 'sessions', 'index.json'), 'utf8'),
  );
  console.log('conversations:', Object.keys(index.sessions ?? {}).length);
} catch {
  console.log('conversations: (no index written)');
}

const interesting = out
  .split('\n')
  .filter(
    (line) =>
      /\[marimo\]/u.test(line) &&
      !/dconf|drmGet|NSS|dbus|Glycin|Vulkan/u.test(line),
  );
if (interesting.length > 0) {
  console.log('\n--- app output ---\n' + interesting.slice(-10).join('\n'));
}
