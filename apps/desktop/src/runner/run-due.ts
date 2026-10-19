/**
 * The headless job runner.
 *
 * This is the other half of "Marimo Bot is always on". With the option
 * enabled, the OS wakes this process on a one-minute timer; it works out which
 * jobs are due, runs them, and exits. It is the *same* binary as the app —
 * started with `ELECTRON_RUN_AS_NODE=1`, so Electron behaves as plain Node —
 * which is what gives it the same agent core, the same stores and the same
 * conversation files without shipping a second runtime or a second copy of the
 * logic.
 *
 * Three consequences of that choice are the shape of the whole feature:
 *
 * **No display is required.** A plain Electron process needs a display server,
 * so it cannot be the thing a boot-time timer launches. Running as Node means
 * this works over SSH, in a container, and at login before any compositor is up.
 *
 * **No `safeStorage`, and the one thing that needs it.** There is no `app` object
 * in Node mode, so a secret encrypted by the window cannot be decrypted here.
 * That is why a provider's key can be stored readable — per provider, by the
 * user's own choice — and why a job on an encrypted one fails with a sentence
 * naming the setting rather than with a failed request. See `readSecret` below.
 *
 * **No web search.** That runs in a browser engine, and there is none here.
 * `web_search` is simply not offered, and the operating rules have the model say
 * a capability is missing rather than pretend.
 *
 * It does not need to avoid running while the app is open: the store's own
 * claim on an occurrence is what makes a job run once. Checking the app's lock
 * first is an optimisation — it saves building an agent and dialling every MCP
 * server beside an app doing the same — not a correctness measure.
 */
import {pathToFileURL} from 'node:url';

import {RecallHost} from '../main/recall.js';

import {PROVIDERS} from '@marimo/protocol';
import type {McpServer} from '@marimo/protocol';
import {
  AgentRuntime,
  createJobRunner,
  FileSecretStore,
  holdProcessLock,
  isProcessHeld,
  JobScheduler,
  JobStore,
  McpManager,
  resolveAppPaths,
  secretReaderFor,
} from '@marimo/runtime';
import type {AppPaths} from '@marimo/runtime';
import type {McpResolvedSecrets} from '@marimo/agent';

import {
  adoptFormerUserDataDir,
  MCP_CLIENT,
  PRODUCT_NAME,
  userDataDirFor,
} from '../shared/product.js';

export interface RunDueReport {
  userData: string;
  /** Whether the app was already running the jobs. */
  appIsRunning: boolean;
  total: number;
  enabled: number;
  due: number;
  ran: string[];
  /**
   * Connectors that are enabled and did not come up, with the reason.
   *
   * Not a `problem`: a connector that is down costs a job the tools it was
   * granted, and the jobs still run — a run that refused to start because one
   * server was unreachable would be a worse answer than a run that does less and
   * says so. They are reported because the alternative is silence: nobody is
   * watching a timer's output, so the one place a person can find out why a
   * scheduled job's answer was thin is the log this report is printed to. The
   * reason is the manager's own sentence, which for a secret this process cannot
   * decrypt names the setting that fixes it.
   */
  connectorProblems?: string[];
  /**
   * Why the runner could not do its job, when it could not.
   *
   * Present means trouble, and it is what makes the exit code non-zero: for a
   * timer, "exit 0, nothing happened" and "exit 0, I could not read the file"
   * are the same observation, and the second one is the failure nobody notices.
   */
  problem?: string;
}

/**
 * Where this process should look.
 *
 * The same decision the window makes, through the same function — the override
 * first, because that is what a development run and the smoke check set and it is
 * the variable the app honours, and otherwise the platform's own rules with the
 * *folder's* name appended, worked out without an `app` object to ask.
 */
export function resolveRunnerPaths(
  env: NodeJS.ProcessEnv = process.env,
): AppPaths {
  return resolveAppPaths(userDataDirFor(env));
}

/**
 * The connector credentials this process can read.
 *
 * The runner's half of invariant 16, and the reason a connector has a
 * `secretStorage` choice at all. This process has no `app` object, so it has no
 * keychain and cannot decrypt: a connector whose secret the user stored readable
 * is dialled with it, and one stored encrypted comes back `unreadable` with the
 * store's own sentence — which the manager puts in the server's status, and this
 * file puts in the report, rather than the runner dialling without a credential
 * and earning a `401` from a server that never saw one.
 *
 * The store is built here rather than in `@marimo/runtime` for the reason the
 * provider reader below is: the cipher is the one thing only the calling process
 * knows, and this one has none to give.
 */
export function connectorSecrets(
  paths: AppPaths,
): (server: McpServer) => Promise<McpResolvedSecrets> {
  return secretReaderFor(
    paths,
    (file, label) => new FileSecretStore(file, label),
  );
}

/**
 * The connectors that are enabled and did not come up, as sentences.
 *
 * Read from the manager after it has been given the server list, which is the
 * only way to learn what happened: every failure is caught there by design, so a
 * connector that could not be dialled is a status rather than an exception.
 */
function connectorProblemsIn(
  mcp: McpManager,
  servers: readonly McpServer[],
): string[] {
  const problems: string[] = [];
  for (const server of servers) {
    const status = mcp.statusOf(server.id);
    if (status.state === 'error') {
      problems.push(`${server.name}: ${status.detail}`);
    }
  }
  return problems;
}

/**
 * Looks at the clock once and runs whatever is due.
 *
 * One look rather than a loop: the OS timer is the loop. `tick()` awaits the
 * dispatch queue, so by the time this returns, every job it started has
 * finished, and the process can exit without leaving a turn half-written.
 */
export async function runDue(options: {
  paths: AppPaths;
  /** Told about each job as it starts, for a log a person reads. */
  onRun?: (jobId: string) => void;
}): Promise<RunDueReport> {
  const {paths} = options;

  if (await isProcessHeld(paths.appLock)) {
    return {
      userData: paths.userData,
      appIsRunning: true,
      total: 0,
      enabled: 0,
      due: 0,
      ran: [],
    };
  }

  const jobs = new JobStore({file: paths.jobs});
  const {problem} = await jobs.loadChecked();
  if (problem !== undefined) {
    return {
      userData: paths.userData,
      appIsRunning: false,
      total: 0,
      enabled: 0,
      due: 0,
      ran: [],
      problem,
    };
  }

  /*
   * Recall, in its read-only form.
   *
   * A scheduled job may search an index the window built and may never write one:
   * it has nobody watching, it can be killed at any moment, and two processes
   * indexing the same folder is the fight the file lock exists to prevent. The
   * engine is still started on demand, because turning a question into a vector
   * needs it — what is refused is the refresh.
   */
  const recall = new RecallHost({
    userData: paths.userData,
    // The same person-level memory the window reads: a search from a scheduled
    // job has to find a fact about the user that the window wrote, and vice versa.
    personMemoryDir: paths.personMemoryDir,
    // Assigned below: the settings live on the runtime, and the host reads them
    // per call rather than at construction, so this closure is never called early.
    readSettings: async () => await agent.settings(),
    readOnly: true,
    /*
     * The conversations corpus, from the same runtime the job's own tools use.
     * The runner never *builds* an index, so these are only ever called to read a
     * hit back — but a chat the window indexed should be findable from a
     * scheduled job too, and the alternative is a search that quietly answers
     * about the folder while the question was about something the user said.
     */
    listConversations: async (profileId) =>
      (await agent.listSessions(profileId)).map((session) => ({
        sessionId: session.id,
        title: session.title,
        eventCount: session.messageCount,
      })),
    readConversation: async (profileId, sessionId) =>
      await agent.conversationFor(profileId, sessionId),
  });

  /*
   * The connectors, dialled for the duration of this run.
   *
   * A job's agent is the same agent the window runs, so a scheduled job whose
   * prompt needs a connector's tool must be offered it — otherwise the job
   * quietly does less than it was asked to, and the user finds out by reading an
   * answer that says it could not do something the app can do. This is the
   * window's own manager over the window's own settings document; the only
   * difference is the reader, which has no cipher here.
   */
  const mcp = new McpManager({
    readSecrets: connectorSecrets(paths),
    clientName: MCP_CLIENT.name,
    clientVersion: MCP_CLIENT.version,
  });

  const agent: AgentRuntime = new AgentRuntime({
    paths,
    appName: PRODUCT_NAME,
    /*
     * No cipher, deliberately, and it is the whole of invariant 16 from this
     * side. There is no `app` object in Node mode and therefore no `safeStorage`,
     * so a key encrypted for the window could not be decrypted here even if this
     * asked nicely. A key the user made readable is read, and an encrypted one
     * comes back `unreadable` with the store's own sentence — which the job
     * records against itself, so the failure a person sees names the setting that
     * fixes it rather than arriving as a `401`.
     */
    readSecret: async (provider) =>
      await new FileSecretStore(
        paths.providerSecrets[provider],
        `${PROVIDERS[provider].label} API key`,
      ).read(),
    /*
     * What the servers are offering, read per turn rather than captured: a
     * connector that drops mid-run is a tool the next turn must not be offered,
     * and the manager is the one thing that knows which are up.
     */
    mcpServers: () => mcp.toolsets(),
    recall: {
      stop: async () => {
        await recall.stop();
      },
    },
    services: async (profileId, workspaceRoot) => {
      const service = await recall.serviceFor(profileId, workspaceRoot);
      return service === undefined ? {} : {recallService: service};
    },
  });

  /*
   * Claimed for the duration of the work, not merely checked.
   *
   * Checking once at startup was one-directional: it told this process whether
   * an app was up, and told the app nothing. So an app launched while a runner
   * was mid-turn found the lock free, took it, and ran its own scheduler beside
   * this one — two processes running turns at once, which is the thing the
   * invariant says must not happen. Holding it makes the exclusion symmetric,
   * and the app waits for this to be released.
   */
  const lock = await holdProcessLock(paths.appLock);
  if (lock === undefined) {
    // Somebody took it between the check above and here. Theirs.
    await agent.dispose();
    return {
      userData: paths.userData,
      appIsRunning: true,
      total: 0,
      enabled: 0,
      due: 0,
      ran: [],
    };
  }

  /*
   * The servers come up after the lock and before the first job, in that order
   * for a reason at each end: dialling them while an app is running would put a
   * second connection beside every server the app is already holding, and a job
   * dispatched before they are up would be answered by an agent with no
   * connectors — the thing this whole path exists to avoid.
   */
  const settings = await agent.settings();
  await mcp.apply(settings.mcpServers);
  const connectorProblems = connectorProblemsIn(mcp, settings.mcpServers);

  /*
   * `onChange` is the scheduler saying it recorded something about a job —
   * which is every dispatch outcome, including a deferral and a gate. A `Set`
   * because one job can record twice in a run: once when it starts, once when
   * it ends.
   */
  const ran = new Set<string>();
  const scheduler = new JobScheduler({
    store: jobs,
    runner: createJobRunner({runtime: agent, harness: agent.harness(), jobs}),
    onChange: (jobId) => {
      ran.add(jobId);
      options.onRun?.(jobId);
    },
  });

  try {
    // One look, waited for. Not `start`, which arms a timer this process will
    // never reach, and not `tick`, which is written for a caller that will be
    // back — this process is about to exit, and a turn still running would be
    // killed mid-write.
    await scheduler.runOnce();
  } finally {
    await lock.release();
    // Before the runtime, so a connector's child process is stopped by the object
    // that started it rather than left to the process exiting.
    await mcp.stop();
    await agent.dispose();
  }

  const after = await jobs.load();
  return {
    userData: paths.userData,
    appIsRunning: false,
    total: after.jobs.length,
    enabled: after.jobs.filter((job) => job.enabled).length,
    due: ran.size,
    ran: [...ran],
    ...(connectorProblems.length === 0 ? {} : {connectorProblems}),
  };
}

/** The report as lines a person reads in a log. */
export function describeReport(report: RunDueReport): string[] {
  const lines = [`${PRODUCT_NAME} job runner`];

  if (report.problem !== undefined) {
    lines.push(`  FAILED: ${report.problem}`);
    return lines;
  }

  if (report.appIsRunning) {
    /*
     * Not a failure, and said plainly rather than logged as an error: the app
     * runs the jobs while it is open, so there was nothing for this process to
     * do.
     */
    lines.push('  the app is running, so it is looking after the jobs.');
    return lines;
  }

  lines.push(`  data directory: ${report.userData}`);
  /*
   * Before the jobs, because a connector that is down is the explanation for
   * several of them: "it answered without the tool I asked for" reads as the
   * model's fault until this line says otherwise.
   */
  for (const problem of report.connectorProblems ?? []) {
    lines.push(`  connector not connected: ${problem}`);
  }
  if (report.ran.length === 0) {
    lines.push(
      `  jobs: ${report.total} (${report.enabled} enabled), none due.`,
    );
    return lines;
  }

  lines.push(`  ran ${report.ran.length} job(s):`);
  for (const jobId of report.ran) {
    lines.push(`    - ${jobId}`);
  }
  return lines;
}

interface Options {
  json: boolean;
}

function parseArguments(argv: readonly string[]): Options {
  return {json: argv.includes('--json')};
}

/**
 * Runs the report and answers the exit code the OS timer will see.
 *
 * Exported so the app can call it directly when it is the one that came due, and
 * so a test can assert on the code rather than on a spawned process.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const options = parseArguments(argv);

  try {
    const report = await runDue({paths: resolveRunnerPaths()});
    if (options.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const line of describeReport(report)) {
        process.stdout.write(`${line}\n`);
      }
    }
    // A report with a problem in it is a failed run, not a quiet one.
    return report.problem === undefined ? 0 : 1;
  } catch (error) {
    /*
     * A non-zero exit is the only signal the OS timer has. It is reserved for
     * "this process could not do its job" — a corrupt jobs file, a data
     * directory it cannot read — and never for "there was nothing to do", which
     * is the ordinary case for a timer that fires every minute.
     */
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[marimo] the job runner could not start: ${detail}\n`,
    );
    return 1;
  }
}

/**
 * Whether this module is the process's entry point.
 *
 * Checked before doing any work, because the app imports this module too: an
 * unguarded top-level call would make importing it run a job report as a side
 * effect, which in the app means a stray write to stdout and a process exit code
 * set by something the user never asked for.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  /*
   * The folder moves here rather than inside `resolveRunnerPaths`, because a test
   * calls that with an environment of its own and this is the one place that
   * knows it is the real process on the real machine. It is the runner as well as
   * the window because the timer can be the first thing to run after an upgrade:
   * nobody has to open the window for a scheduled job to come due.
   */
  adoptFormerUserDataDir();
  process.exitCode = await main();
}
