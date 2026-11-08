/**
 * The single IPC entry point.
 *
 * The window can invoke exactly one channel, and every call is checked against
 * the protocol's schema before it reaches a handler. An unknown method or a
 * malformed payload is refused at the boundary, so a renderer bug — or a
 * renderer running something it should not be — cannot reach the agent with
 * half-typed arguments.
 *
 * Errors are thrown rather than returned, because Electron already propagates a
 * rejected `invoke` to the caller: an envelope would be a second error channel
 * to keep in step with the first. The one exception is a turn's *own* refusal,
 * which is not an error in this sense — see `AgentService.send`.
 */
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {totalmem} from 'node:os';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell,
} from 'electron';
import type {OpenDialogOptions} from 'electron';

import {agentCallSchemas, IPC_CALL_CHANNEL} from '@marimo/protocol';
import type {
  LocalModelId,
  LocalModelVariant,
  RetiredModelId,
} from '@marimo/protocol';

import {checkForUpdates} from './updates.js';
import type {
  AgentCallMethod,
  AgentCallParams,
  AgentCallResults,
  AppInfo,
  PublicSettings,
  ThemeMode,
} from '@marimo/protocol';
import type {AppPaths} from '@marimo/runtime';
import {missingProblem} from '@marimo/runtime';

import {PRODUCT_NAME} from '../shared/product.js';

import {attachableFiles} from './attach.js';
import {uploadBotAvatar} from './avatar.js';
import type {AgentService} from './agent.js';
import {settingsForWindow} from './public-settings.js';
import {safeStorageCipher} from './secrets.js';
import type {Companion} from './companion.js';
import {disable, enable, statusOf} from './service.js';
import type {ServiceContext} from './service.js';

export interface IpcDependencies {
  paths: AppPaths;
  /** The agent, once it has started. Absent if it failed to. */
  agent: () => AgentService | undefined;
  /**
   * The theme the user chose.
   *
   * Injected rather than read from a settings file here, so this module has no
   * opinion about where preferences live. Until Settings exists it answers
   * `system`, which is the default the app ships with anyway.
   */
  themeMode?: () => ThemeMode;
  /** Told after a settings write, so anything holding a copy can re-read. */
  onSettingsChanged?: () => void;
  /**
   * The floating companion, when one has been created.
   *
   * A getter rather than the window itself, because the tray and the window can
   * each turn it off and on, and a caller holding a destroyed window would be
   * holding the wrong one.
   */
  companion?: () => Companion | undefined;
  /**
   * A problem worth showing the user, decided once at startup.
   *
   * Passed in rather than worked out here because it is a fact about the paths
   * this process resolved, and this module's job is answering calls — not
   * deciding what is wrong with the install.
   */
  warning?: string;
  /**
   * Running jobs while the app is closed.
   *
   * Injected rather than built here: it names the app's own binary and decides
   * whether the stored key is one a windowless process could read, and neither
   * is a question about answering IPC calls.
   */
  service?: ServiceContext;
  /**
   * Erases this install and ends the app.
   *
   * Injected for the reason the service context above is: it stops the agent,
   * switches the OS timer and the login item off, empties the user-data folder
   * and quits the process — which is the shape of a program ending, and not the
   * shape of answering a call. Absent in a build with no such flow, and the
   * handler says so rather than appearing to work.
   */
  onReset?: () => Promise<void>;
}

/** Every call this app answers, with its result type pinned to the protocol. */
type Handlers = {
  [M in AgentCallMethod]: (
    params: AgentCallParams<M>,
  ) => Promise<AgentCallResults[M]> | AgentCallResults[M];
};

export function registerIpcHandler(dependencies: IpcDependencies): void {
  const themeMode = dependencies.themeMode ?? ((): ThemeMode => 'system');

  /** The agent, or a thrown sentence naming what went wrong at startup. */
  const agent = (): AgentService => {
    const service = dependencies.agent();
    if (service === undefined) {
      throw new Error(
        `${PRODUCT_NAME} did not start. Check the app log, then reopen it.`,
      );
    }
    return service;
  };

  /**
   * The settings a window may see.
   *
   * No credential is here and none can be: the models run on this machine, so
   * there is no model key at all. What crosses is the model situation — what is
   * installed, what is running, and what a first run should recommend — plus the
   * one connector fact the form needs before it asks somebody to type a secret.
   */
  async function publicSettings(): Promise<PublicSettings> {
    const service = dependencies.agent();
    if (service === undefined) {
      throw new Error(`${PRODUCT_NAME} is not running.`);
    }
    const settings = await service.settings();
    const profiles = await service.profiles();
    const readiness = await modelReadiness(service);
    const localModels = await service.modelStatus();

    return settingsForWindow({
      settings,
      readiness,
      /*
       * Asked every time rather than cached: on Linux a keyring that was locked
       * at launch can become usable later in the session, and the connector form
       * has to know before it offers a field whose storage will refuse it.
       */
      encryptionAvailable: safeStorageCipher.available(),
      localModels,
      hardware: {
        totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
        platform: process.platform,
        arch: process.arch,
      },
      profiles: profiles.profiles,
      activeProfileId: profiles.activeProfileId,
    });
  }

  /**
   * Whether this install could answer a question right now.
   *
   * A fact only the main process has: the window sees a status but not the
   * engine, and "the chat model's weights and the engine are both here" is not
   * something it can work out for itself. A window that guessed would open a chat
   * on a machine that cannot reply.
   *
   * The order is the order of the fixes. A platform with no engine build cannot
   * be fixed by a download, and saying so before 1.9GB is spent is the whole
   * reason the engine is checked first. After that, a missing file is a
   * download, and the sentence names the parts.
   */
  async function modelReadiness(
    service: AgentService,
  ): Promise<{ok: boolean; problem?: string}> {
    const settings = await service.settings();
    const status = await service.modelStatus();
    if (!status.engine.platformSupported) {
      return {
        ok: false,
        problem:
          `This build has no llama.cpp engine for ${process.platform}-${process.arch}, ` +
          'so it cannot run a local model on this computer.',
      };
    }
    const modelId = settings.localModels.tasks.chat;
    const model = status.models[modelId];
    if (model === undefined) {
      return {
        ok: false,
        problem: `The chat model is set to ${modelId}, which this build does not ship.`,
      };
    }
    if (model.installed) {
      return {ok: true};
    }
    return {ok: false, problem: missingProblem(modelId, model.missing)};
  }

  /** Both halves of what the window needs after an agent changes. */
  async function profileState(service: AgentService) {
    const {profiles, activeProfileId} = await service.profiles();
    return {profiles, activeProfileId};
  }

  /**
   * Asks the user for a folder, with the OS's own picker.
   *
   * `undefined` means they closed it. The parented form is used when there is a
   * window to parent to, because a modal dialog attached to nothing can end up
   * behind the window it was opened from.
   */
  async function pickFolder(): Promise<string | undefined> {
    const options: OpenDialogOptions = {
      title: 'Choose a space to work in',
      buttonLabel: 'Use this space',
      properties: ['openDirectory'],
      defaultPath: await startFolder(),
    };
    const parent = BrowserWindow.getFocusedWindow();
    const result =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    return result.canceled ? undefined : result.filePaths[0];
  }

  /**
   * Where the picker opens: the folder already in use, else the app's starting
   * folder.
   *
   * The folder in use rather than the home directory, because the common case is
   * adding a second project beside the first. The fallback is `<home>/Marimo`
   * rather than home for the same reason the starting Space is: it is a place to
   * work, not everything the person owns.
   */
  async function startFolder(): Promise<string> {
    const service = dependencies.agent();
    if (service !== undefined) {
      const {workspaces, activeWorkspaceId} = await service.workspaces();
      const active = workspaces.find((entry) => entry.id === activeWorkspaceId);
      if (active !== undefined) {
        return active.path;
      }
    }
    return dependencies.paths.defaultWorkspace;
  }

  /** A folder the window named directly has to exist and be a directory. */
  async function requireDirectory(path: string): Promise<void> {
    const stats = await stat(path).catch(() => undefined);
    if (stats === undefined || !stats.isDirectory()) {
      throw new Error(`Not a space: ${path}`);
    }
  }

  /**
   * Asks for files, in the folder this conversation works in.
   *
   * The dialog opens there, and the chosen paths are then judged by
   * `attachableFiles` — a native picker cannot be confined to a folder, so the
   * offer is the dialog and the decision is the function beside this one. An
   * empty list means the user closed the dialog, which is an answer rather than
   * a failure.
   */
  async function pickFiles(root: string): Promise<string[]> {
    const options: OpenDialogOptions = {
      title: 'Attach files',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections'],
      defaultPath: root,
    };
    const parent = BrowserWindow.getFocusedWindow();
    const result =
      parent === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(parent, options);
    return result.canceled ? [] : result.filePaths;
  }

  const handlers: Handlers = {
    'files.pick': async (params) => {
      const service = agent();
      const folder = await service.conversationFolder(
        params.profileId,
        params.sessionId,
      );
      if (folder === undefined) {
        throw new Error(
          'This conversation has no space yet. Load one, then attach files ' +
            'from it.',
        );
      }
      const picked = await pickFiles(folder);
      return {...(await attachableFiles(folder, picked)), folder};
    },

    'app.info': (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions['electron'] ?? '',
      chrome: process.versions['chrome'] ?? '',
      node: process.versions['node'] ?? '',
      platform: process.platform,
      userData: dependencies.paths.userData,
      ...(dependencies.warning === undefined
        ? {}
        : {warning: dependencies.warning}),
      themeMode: themeMode(),
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    }),

    /*
     * The last thing this process does, and the one call that does not go
     * through `agent()`: an install whose settings file is unreadable enough to
     * keep the agent from starting is exactly the install somebody reaches for
     * this from, so a reset that needed a working agent would be a repair that
     * only works when nothing is broken.
     *
     * `resetting` is the honest answer rather than a claim: the work has begun
     * and this process is about to end, so nobody can be told how it went. What
     * could not be removed is in the log, which is the only place left.
     */
    'app.reset': async () => {
      if (dependencies.onReset === undefined) {
        throw new Error(`${PRODUCT_NAME} cannot reset itself in this build.`);
      }
      await dependencies.onReset();
      return {resetting: true};
    },

    'settings.set': async (params) => {
      await agent().updateSettings(params.patch);
      dependencies.onSettingsChanged?.();
      return {settings: await publicSettings()};
    },

    'sessions.setParticipants': async (params) => ({
      session: await agent().setParticipants(
        params.profileId,
        params.sessionId,
        params.agentIds,
      ),
    }),

    /*
     * A space's documents.
     *
     * Five calls that name a space rather than a path: the runtime resolves the
     * id through the workspaces document and the service refuses anything that
     * leaves that folder, so what a window can read or write is exactly what the
     * user loaded. The list's `notes` are the caps it hit, passed through
     * untranslated — the window prints them rather than deciding for itself
     * whether something was dropped.
     */
    'docs.list': async (params) =>
      await (await agent().documentsFor(params.spaceId)).list(),

    'docs.read': async (params) =>
      await agent().readDocument(params.spaceId, params.path),

    'docs.write': async (params) =>
      await agent().writeDocument(
        params.spaceId,
        params.path,
        params.text,
        params.revision,
      ),

    'docs.create': async (params) =>
      await agent().createDocument(params.spaceId, params.dir, params.name),

    'docs.saveChat': async (params) =>
      await agent().saveChatAsDocument(
        params.profileId,
        params.sessionId,
        params.spaceId,
        params.path,
      ),

    'mcp.set': async (params) => {
      const servers = await agent().setMcpServer(params.server);
      return {servers, statuses: agent().mcpStatuses()};
    },

    'mcp.remove': async (params) => {
      const servers = await agent().removeMcpServer(params.serverId);
      return {servers, statuses: agent().mcpStatuses()};
    },

    /*
     * Dials a server that has not been saved, so somebody can find out that a
     * command is wrong before committing to it — which is the difference between
     * a typo they fix and a connector that "does not work".
     */
    'mcp.test': async (params) => await agent().testMcpServer(params.server),

    'memory.proposals': async () => ({
      proposals: await agent().memoryProposals(),
      dismissed: await agent().dismissedMemory(),
    }),

    'memory.forgetDismissals': async () => ({
      dismissed: await agent().forgetDismissedMemory(),
    }),

    'memory.usage': async (params) =>
      await agent().memoryUsage(params.profileId),

    'memory.provenance': async (params) => ({
      entries: await agent().memoryProvenance(params.profileId),
    }),

    'memory.forget': async (params) =>
      await agent().forgetMemoryFact(
        {
          scope: params.scope,
          section: params.section,
          text: params.text,
        },
        params.profileId,
      ),

    'memory.resolve': async (params) =>
      await agent().resolveMemoryProposal(params.proposalId, params.accept),

    'learning.proposals': async (params) =>
      await agent().learningProposals(params.profileId),

    'learning.resolve': async (params) =>
      await agent().resolveLearningProposal(params.proposalId, params.accept),

    'learning.forgetLessons': async () => ({
      lessons: await agent().forgetLearningLessons(),
    }),

    'memory.feedback': async (params) => {
      try {
        await agent().recordFeedback({
          sessionId: params.sessionId,
          messageId: params.messageId,
          ...(params.invocationId === undefined
            ? {}
            : {invocationId: params.invocationId}),
          excerpt: params.excerpt,
          ...(params.correction === undefined
            ? {}
            : {correction: params.correction}),
        });
        return {ok: true};
      } catch (error) {
        /*
         * Reported rather than thrown. This runs when somebody presses a button
         * on a message, and an unhandled rejection there is a click that does
         * nothing with no explanation anywhere the user can see.
         */
        return {
          ok: false,
          problem:
            error instanceof Error
              ? error.message
              : 'That could not be recorded.',
        };
      }
    },

    'memory.feedback.list': async () => ({
      entries: await agent().feedback(),
    }),

    'memory.feedback.clear': async () => ({
      entries: await agent().clearFeedback(),
    }),

    'mcp.setSecret': async (params) => {
      await agent().setMcpSecret(
        params.serverId,
        params.target,
        params.name,
        params.value,
        params.secretStorage,
      );
      const settings = await agent().settings();
      const server = settings.mcpServers.find(
        (entry) => entry.id === params.serverId,
      );
      return {
        set: server === undefined ? [] : await agent().mcpSecretState(server),
      };
    },

    'companion.status': () => ({
      visible: dependencies.companion?.()?.isVisible() ?? false,
    }),

    'companion.setVisible': async (params) => {
      const window = dependencies.companion?.();
      if (window === undefined) {
        return {visible: false};
      }
      if (params.visible) {
        await window.show();
      } else {
        window.hide();
      }
      return {visible: window.isVisible()};
    },

    'companion.pointer': (params) => {
      /*
       * `enabled` is ANDed here rather than trusted to have been applied by the
       * renderer: this runs on every mouse move, and a window that stopped
       * forwarding the setting would make the whole surface dead to the mouse —
       * an unclickable pet with nothing on screen to explain why.
       */
      dependencies
        .companion?.()
        ?.setClickThrough(params.enabled && !params.over);
      return {ok: true};
    },

    'service.status': async () =>
      dependencies.service === undefined
        ? {installed: false, definitionPath: '', keysReadable: true}
        : await statusOf(dependencies.service),

    'service.enable': async () =>
      dependencies.service === undefined
        ? {installed: false, notes: [], failures: []}
        : await enable(dependencies.service),

    'service.disable': async () =>
      dependencies.service === undefined
        ? {installed: false, notes: [], failures: []}
        : await disable(dependencies.service),

    /*
     * The local models.
     *
     * A read and five buttons. `install` returns as soon as the download has
     * *started*; progress and completion arrive on the event channel, because an
     * invoke that blocked for 1.9GB is one nobody could cancel.
     */
    'models.status': async () => await agent().modelStatus(),
    'models.install': async (params: {
      modelId: LocalModelId;
      variant: LocalModelVariant;
    }) => await agent().installModel(params.modelId, params.variant),
    'models.cancel': () => agent().cancelModelInstall(),
    'models.remove': async (params: {modelId: LocalModelId}) => ({
      status: await agent().removeModel(params.modelId),
    }),
    'models.removeRetired': async (params: {modelId: RetiredModelId}) => ({
      status: await agent().removeRetiredModel(params.modelId),
    }),
    'models.sleep': async () => ({status: await agent().sleepModels()}),
    'models.warm': async (params: {modelId: LocalModelId}) =>
      await agent().warmModel(params.modelId),

    /* Recall: a read and four buttons. */
    'recall.status': async () => await agent().recallStatus(),
    'recall.install': async (params) =>
      await agent().recallInstall(params.piece),
    'recall.cancel': () => agent().recallCancel(),
    'recall.reindex': async () => await agent().recallReindex(),
    'recall.forget': async () => await agent().recallForget(),
    'recall.query': async (params) =>
      await agent().recallQuery(
        params.query,
        params.scopes,
        params.limit,
        params.minScore,
      ),

    'profiles.list': async () => await agent().profiles(),

    'profiles.catalog': async () => await agent().catalog(),

    'profiles.update': async (params) => {
      await agent().updateProfile(params.profileId, params.patch);
      return await profileState(agent());
    },

    'profiles.create': async (params) => {
      const agent0 = agent();
      const created = await agent0.createProfile(
        params.draft,
        params.sourceCallId,
      );
      // Switched to straight away: somebody who adds an agent wants to be
      // looking at it, not at the one they were on. The caller gets the bot it
      // made as well, because every flow here selects the lead back before it
      // answers.
      await agent0.selectProfile(created.id);
      return {...(await profileState(agent0)), created};
    },

    'profiles.select': async (params) => {
      const service = agent();
      await service.selectProfile(params.profileId);
      return await profileState(service);
    },

    /*
     * The picker and the picture are main-process work; the profile only learns
     * that this bot now wears a custom icon. The profile is checked before the
     * picker opens, so a stale id fails before a file can be written for nobody.
     */
    'profiles.uploadAvatar': async (params) => {
      const service = agent();
      const {profiles} = await service.profiles();
      if (!profiles.some((entry) => entry.id === params.profileId)) {
        throw new Error(`Unknown bot: ${params.profileId}`);
      }
      const changed = await uploadBotAvatar(
        dependencies.paths.avatars,
        params.profileId,
      );
      if (changed) {
        await service.updateProfile(params.profileId, {
          avatar: {kind: 'custom', id: randomUUID()},
        });
      }
      return {...(await profileState(service)), changed};
    },

    'profiles.remove': async (params) => {
      const service = agent();
      await service.removeProfile(params.profileId);
      return await profileState(service);
    },

    /*
     * The user's skills. `save_skill` writes the same files from inside a turn;
     * these are the two ways a person edits one without asking the model.
     */
    'skills.list': async () => ({skills: await agent().skills()}),
    'skills.save': async (params) =>
      await agent().saveSkill(params.draft, params.id),
    'sessions.usage': async (params) =>
      await agent().sessionUsage(params.profileId, params.sessionId),

    'updates.check': async () =>
      await checkForUpdates({currentVersion: app.getVersion()}),

    'harness.restore': async (params) => {
      await agent().restoreHarness(params.profileId, params.hash);
      return {restored: true};
    },

    'harness.report': async (params) =>
      await agent().harnessReport(params.profileId),

    'skills.history': async (params) => ({
      entries: await agent().skillHistory(params.id),
    }),

    'skills.restore': async (params) =>
      await agent().restoreSkill(params.id, params.entryId),

    'skills.remove': async (params) => ({
      skills: await agent().removeSkill(params.id),
    }),

    'settings.get': async () => ({settings: await publicSettings()}),

    /* The folders every agent works in. */
    'workspaces.list': async () => await agent().workspaces(),

    /*
     * Loads a folder. With no path the picker is the only thing that can answer,
     * and a cancelled picker is not a failure: it answers the unchanged list and
     * says so, so the window does not draw an error for a closed dialog.
     */
    'workspaces.add': async (params) => {
      const path = params.path ?? (await pickFolder());
      if (path === undefined) {
        return {...(await agent().workspaces()), added: false};
      }
      await requireDirectory(path);
      return {...(await agent().addWorkspace(path)), added: true};
    },

    'workspaces.select': async (params) =>
      await agent().selectWorkspace(params.workspaceId),

    'workspaces.rename': async (params) =>
      await agent().renameWorkspace(params.workspaceId, params.name),

    'workspaces.remove': async (params) => ({
      ...(await agent().removeWorkspace(params.workspaceId)),
      removed: true,
    }),

    /*
     * Opens the folder in whatever the OS uses for directories.
     *
     * Looked up by id here rather than taken from the window: the only paths this
     * can open are the ones already in the document, so a renderer cannot use it
     * to reveal an arbitrary corner of the disk.
     */
    'workspaces.open': async (params) => {
      const workspace = await agent().workspace(params.workspaceId);
      return {opened: (await shell.openPath(workspace.path)) === ''};
    },

    'sessions.list': async (params) => ({
      sessions: await agent().listSessions(params.profileId),
    }),

    'sessions.create': async (params) => ({
      session: await agent().createSession(params.profileId, params.spaceId),
    }),

    'sessions.startBuilder': async (params) => ({
      session: await agent().startBotBuilder(params.profileId),
    }),

    'sessions.get': async (params) =>
      await agent().transcript(params.profileId, params.sessionId),

    'sessions.move': async (params) => ({
      session: await agent().moveSession(
        params.profileId,
        params.sessionId,
        params.workspaceId,
      ),
    }),

    'sessions.rename': async (params) => ({
      session: await agent().renameSession(
        params.profileId,
        params.sessionId,
        params.title,
      ),
    }),

    'sessions.compact': async (params) =>
      await agent().compact(params.profileId, params.sessionId),

    'sessions.delete': async (params) => {
      await agent().deleteSession(params.profileId, params.sessionId);
      return {deleted: true};
    },

    'chat.send': async (params) =>
      await agent().send(
        params.profileId,
        params.sessionId,
        params.text,
        params.origin,
        params.agentId,
        params.attachments,
      ),

    'chat.approve': async (params) =>
      await agent().approve(
        params.profileId,
        params.sessionId,
        params.callId,
        params.confirmed,
      ),

    'chat.abort': async (params) =>
      agent().abort(params.profileId, params.sessionId),

    'mcp.statuses': async () => agent().mcpStatuses(),
  };

  ipcMain.handle(
    IPC_CALL_CHANNEL,
    async (_event, method: unknown, params: unknown): Promise<unknown> => {
      if (
        typeof method !== 'string' ||
        !Object.hasOwn(agentCallSchemas, method)
      ) {
        /*
         * There is one way this happens in practice, and it is not a typo in a
         * caller: the window is newer than the process behind it. Vite reloads
         * the renderer on every save, and the main process is only rebuilt when
         * the app is started — so a method added to the contract this morning is
         * called by a window whose main process has never heard of it. Said
         * plainly here, because "Unknown IPC method" reads like a bug in the
         * caller and sends the reader looking in the wrong file.
         */
        throw new Error(
          `Unknown IPC method: ${String(method)}. Nothing in this build's ` +
            'contract answers to that name — in development that usually means ' +
            'the window was reloaded and the main process was not. Restart the ' +
            'app, quitting it from the tray rather than closing the window.',
        );
      }

      const key = method as AgentCallMethod;
      const parsed = agentCallSchemas[key].safeParse(params ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) =>
            issue.path.length > 0
              ? `${issue.path.join('.')}: ${issue.message}`
              : issue.message,
          )
          .join('; ');
        throw new Error(`Invalid parameters for ${key}: ${detail}`);
      }

      const handler = handlers[key] as (
        params: unknown,
      ) => Promise<unknown> | unknown;
      return await handler(parsed.data);
    },
  );
}
