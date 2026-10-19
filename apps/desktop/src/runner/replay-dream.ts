/**
 * The offline replay, as a command.
 *
 * Reads the discovery trees this machine has recorded, simulates a grid of
 * controller settings against them, and prints a table. **No model is called and
 * no tool is run** — every number comes from a log that already exists, which is
 * what makes trying twenty settings take a second instead of an afternoon.
 *
 * ```bash
 * node apps/desktop/dist/runner/replay-dream.js            # the default grid
 * node .../replay-dream.js --prune 0,0.5                   # only these thresholds
 * node .../replay-dream.js --explore 0,1,2                 # only these weights
 * node .../replay-dream.js --session <id>                  # one conversation
 * node .../replay-dream.js --json                          # the sweep, for a script
 * ```
 *
 * It is the *same binary as the app*, started as plain Node — the trick
 * `run-due.ts` uses — so it agrees with the window about where the trees are
 * without a second copy of the path logic. `pnpm replay:dream` in the desktop
 * package is the wrapper.
 *
 * Two decisions about this file.
 *
 * **It reuses the app's own path resolution rather than taking a directory.** The
 * trees live under whatever user-data directory the app that recorded them used,
 * and the environment variable that overrides it — `MARIMO_USER_DATA_DIR` — is
 * the same one the headless runner reads. A CLI that defaulted to a path of its
 * own would be this repository's "the app and the runner resolve the same
 * directory" invariant broken a third time, and it would break it silently: a
 * replay that found no logs would say "nothing recorded yet" and look like a
 * feature nobody had used.
 *
 * **It exits non-zero only when it could not do its job.** Finding no logs is a
 * success with a sentence — the user has not recorded anything yet — not a
 * failure, and a script that treated it as one would report a problem every time
 * the feature was off. That is the same distinction the job runner keeps between
 * "nothing due" and "could not read the file", and it matters for the same
 * reason: a timer that cannot tell them apart is a timer nobody can trust.
 */
import {pathToFileURL} from 'node:url';

import type {SearchPolicySettings} from '@marimo/protocol';

import {
  DreamStore,
  renderSweep,
  resolveAppPaths,
  sweepDreamTrees,
} from '@marimo/runtime';

import {adoptFormerUserDataDir, userDataDirFor} from '../shared/product.js';

const USAGE = `Replay recorded discovery trees offline, with no model and no tools.

Usage: replay-dream [options]

  --explore <list>   exploration weights to try, comma separated (default: 0,0.5,1,2)
  --prune <list>     pruning thresholds to try, comma separated (default: -1,0,0.5)
  --session <id>     replay one conversation instead of all of them
  --json             print the sweep as JSON instead of a table
  --help             this text

Rows marked * are the settings the turns were actually recorded under, which is
the measurement every other row is compared against.`;

interface Args {
  explore: number[];
  prune: number[];
  sessionId?: string;
  json: boolean;
  help: boolean;
}

export async function replayDream(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  /*
   * The same decision the app and the runner make, through the same function:
   * the environment variable wins, and otherwise it is the platform's
   * application data directory with the *folder's* name appended — which is not
   * the product name. A replay run from a checkout therefore finds the logs the
   * window wrote.
   */
  const userData = userDataDirFor();
  const paths = resolveAppPaths(userData);

  const store = new DreamStore({
    dir: paths.dreamDir,
    /*
     * Not the user's setting, because nothing is being written here. Every tree
     * in the file is read regardless of the cap: the cap decides what survives a
     * *new* write, and a replay that silently ignored old turns because the user
     * lowered a limit after recording them would make the comparison depend on an
     * unrelated preference.
     */
    keepLogs: () => Number.MAX_SAFE_INTEGER,
  });

  const sweep = await sweepDreamTrees({
    store,
    candidates: grid(args),
    ...(args.sessionId === undefined ? {} : {sessionId: args.sessionId}),
    /*
     * From the same directory the app writes. A replay that took the path as an
     * argument could be pointed at another install's notes — and the whole reason
     * this command lives in `runner` is that it resolves the directory the way the
     * window does.
     */
    feedbackFile: paths.feedback,
  });

  process.stdout.write(
    args.json ? `${JSON.stringify(sweep, null, 2)}\n` : `${renderSweep(sweep)}\n`,
  );
  return 0;
}

/**
 * The settings to simulate.
 *
 * The stored settings are *not* read from `settings.json`, and that is the
 * deliberate part: what matters is the weights the recorded turns ran under,
 * because those are the control the comparison is against. That is in the logs
 * themselves — every tree carries the policy it ran under — so the baseline row
 * is whatever the turns actually did, and a user who changed the setting after
 * recording still gets a baseline that is real.
 *
 * The grid is ordered exploration outer, pruning inner, so the output reads as
 * each weight tried against every threshold.
 */
function grid(args: Args): SearchPolicySettings[] {
  const candidates: SearchPolicySettings[] = [];
  const seen = new Set<string>();
  for (const explorationWeight of args.explore) {
    for (const pruningThreshold of args.prune) {
      const key = `${explorationWeight}/${pruningThreshold}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({explorationWeight, pruningThreshold});
    }
  }
  return candidates;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    /*
     * The defaults, and the shape of them is the point. `-1` is "prune nothing",
     * which is what ships; `0` is the interesting one, because it removes
     * anything that has not earned a positive reward — right for a tool that
     * fails and wrong for one that has simply not been tried. `--explore 0` is
     * the controller that never tries anything new. A sweep that varied in one
     * direction only would be an advertisement rather than a measurement.
     */
    explore: [0, 0.5, 1, 2],
    prune: [-1, 0, 0.5],
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--explore':
      case '--prune':
      case '--session': {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error(`${flag} needs a value.`);
        }
        index += 1;
        if (flag === '--session') {
          args.sessionId = value;
        } else {
          const numbers = parseNumbers(value, flag);
          if (flag === '--explore') {
            args.explore = numbers;
          } else {
            args.prune = numbers;
          }
        }
        break;
      }
      default:
        /*
         * A bad flag is a real failure and exits non-zero, unlike finding no
         * logs: one is a person who mistyped, the other is an app nobody has
         * asked to record anything.
         */
        throw new Error(`Unknown option "${flag ?? ''}".\n\n${USAGE}`);
    }
  }

  return args;
}

function parseNumbers(value: string, flag: string): number[] {
  const numbers = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const parsed = Number(part);
      if (!Number.isFinite(parsed)) {
        throw new Error(`${flag} expects numbers, and "${part}" is not one.`);
      }
      return parsed;
    });
  if (numbers.length === 0) {
    throw new Error(`${flag} needs at least one number.`);
  }
  return numbers;
}

/*
 * Started the way `run-due.ts` is: the module is importable so a test can call
 * `replayDream` with arguments of its own, and running it as a program does the
 * work. `process.argv[1]` compared as a URL rather than a path, because the two
 * differ on Windows and this app ships there.
 */
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    // A replay run from a checkout reads what the window wrote, so it has to be
    // looking at the same folder — which means adopting the move if it is the
    // first thing to run after the upgrade.
    adoptFormerUserDataDir();
    process.exitCode = await replayDream(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
