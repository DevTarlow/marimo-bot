/**
 * The catalogue the model is offered.
 *
 * Adding a tool is easy; making sure the model can see it, or that a gate is
 * still in place, is what this test is for.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {AgentConfig} from '../config.js';
import {MemoryStore} from '../memory/index.js';
import type {RecallLookup} from './recall-tools.js';

/**
 * A recall service that claims both corpora.
 *
 * `scopes()` is what decides whether the tool is built at all, so a stub that
 * answered with an empty list would make every comparison in this file pass by
 * absence — and recall is a *default*, which means the tests that check the
 * defaults and the catalogue both have to be able to build it.
 */
function recallStub(): RecallLookup {
  return {
    scopes: () => ['folder', 'memory'],
    search: async () => ({hits: [], searched: [], notes: []}),
  };
}
import {toOpenAiTools} from '../models/openai-mapping.js';
import {
  CAPABILITY_PRESETS,
  createTools,
  describeTools,
  SAFE_DEFAULT_TOOLS,
} from './index.js';
import type {WebSearchProvider} from './web-search-tool.js';

describe('createTools', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-tools-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  function config(): AgentConfig {
    return {
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: '',
      systemPrompt: 'test',
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
    };
  }

  function memory(): MemoryStore {
    return new MemoryStore({workspaceRoot: workDir});
  }

  function names(tools: ReturnType<typeof createTools>): string[] {
    return tools.map((tool) => tool.name);
  }

  it('offers the same catalogue in a stable order', () => {
    expect(
      names(
        createTools(config(), {
          memory: memory(),
          model: 'deepseek-chat',
          provider: 'deepseek',
        }),
      ),
    ).toEqual([
      'current_time',
      'read_file',
      'list_dir',
      'write_file',
      'search_knowledge_base',
      'read_memory',
      'update_memory',
      'prune_memory',
      'http_fetch',
      'run_shell',
      'draft_bot',
    ]);
  });

  it('adds web_search only when the host injected a provider', async () => {
    const provider: WebSearchProvider = {search: async () => []};
    const withProvider = names(
      createTools(config(), {
        memory: memory(),
        model: 'deepseek-chat',
        provider: 'deepseek',
        webSearch: provider,
      }),
    );
    expect(withProvider).toContain('web_search');
    expect(withProvider.indexOf('web_search')).toBe(9);
    expect(withProvider.indexOf('run_shell')).toBe(10);
    expect(
      names(
        createTools(config(), {
          memory: memory(),
          model: 'deepseek-chat',
          provider: 'deepseek',
        }),
      ),
    ).not.toContain('web_search');
  });

  /**
   * Scheduling is part of the app, not of the agent: with no job service to write
   * to, the four tools would be promises the model could not keep. The tools
   * themselves have their own test; this is the placement.
   */
  it('adds the scheduling tools only when a job service is injected', () => {
    const jobs = {
      list: async () => [],
      create: async () => {
        throw new Error('not used');
      },
      update: async () => null,
      remove: async () => false,
    };
    const withJobs = names(
      createTools(config(), {
        memory: memory(),
        model: 'deepseek-chat',
        provider: 'deepseek',
        jobService: jobs,
      }),
    );
    expect(withJobs.slice(10)).toEqual([
      'list_jobs',
      'create_job',
      'update_job',
      'delete_job',
      'draft_bot',
    ]);
  });

  /**
   * The desk is the app's own two documents, so the tools follow the same rule
   * the scheduling ones do: no service, no tools. The placement matters because
   * the catalogue is what a profile's checkboxes are seeded from.
   */
  it('adds the desk tools only when a desk service is injected', () => {
    const desk = {
      todos: async () => ({items: [], activeId: null, open: true}),
      addTodo: async () => ({items: [], activeId: null, open: true}),
      updateTodo: async () => ({
        document: {items: [], activeId: null, open: true},
        found: false,
      }),
      removeTodo: async () => ({
        document: {items: [], activeId: null, open: true},
        found: false,
      }),
      notes: async () => ({items: [], open: false}),
      addNote: async () => ({items: [], open: false}),
      updateNote: async () => ({
        document: {items: [], open: false},
        found: false,
      }),
      removeNote: async () => ({
        document: {items: [], open: false},
        found: false,
      }),
    };
    expect(
      names(
        createTools(config(), {
          memory: memory(),
          model: 'deepseek-chat',
          provider: 'deepseek',
        }),
      ),
    ).not.toContain('list_todos');

    const withDesk = names(
      createTools(config(), {
        memory: memory(),
        model: 'deepseek-chat',
        provider: 'deepseek',
        deskService: desk,
      }),
    );
    expect(withDesk.slice(10, 18)).toEqual([
      'list_todos',
      'add_todo',
      'update_todo',
      'remove_todo',
      'list_notes',
      'add_note',
      'update_note',
      'remove_note',
    ]);
    // And the scheduling tools still come after them.
    expect(withDesk.indexOf('run_shell')).toBeLessThan(
      withDesk.indexOf('list_todos'),
    );
  });

  /**
   * Writing a skill is a grant like any other now.
   *
   * It used to be appended after the profile's selection because it was the
   * mechanism behind `/learn`: a profile that predated the command still had to
   * be able to run it. The cost of that was a bot writing text that changes its
   * own future prompts without the person ever ticking a box. The tool is in the
   * catalogue and filtered like the rest, and the command is offered only when
   * the grant is there — one fact in both places.
   */
  it('offers save_skill only when the profile grants it', () => {
    const skills = {
      save: async () => ({name: 'a-skill', updated: false}),
    };
    const deps = {
      memory: memory(),
      model: 'deepseek-chat',
      provider: 'deepseek' as const,
      skillService: skills,
    };

    expect(
      names(
        createTools(
          {...config(), enabledTools: ['read_file', 'save_skill']},
          deps,
        ),
      ),
    ).toEqual(['read_file', 'save_skill']);

    expect(
      names(createTools({...config(), enabledTools: ['read_file']}, deps)),
    ).toEqual(['read_file']);

    // A profile that deliberately allows nothing gets nothing.
    expect(names(createTools({...config(), enabledTools: []}, deps))).toEqual(
      [],
    );

    // And with no skill service there is nothing to write with, so no tool.
    expect(
      names(
        createTools(config(), {
          memory: memory(),
          model: 'deepseek-chat',
          provider: 'deepseek',
        }),
      ),
    ).not.toContain('save_skill');
  });

  /**
   * The reader is implied by the grant rather than switched separately: a person
   * who turned three procedures on did not also decide to let the model read
   * them. It is added after the filter, so it survives a profile that narrowed
   * its tool list, and it is absent when no library was handed over.
   */
  it('offers load_skill when the app can read skills', () => {
    const library = {
      load: async (name: string) => ({
        skill: {name, description: 'd', instructions: 'i'},
        names: [name],
      }),
    };
    const deps = {
      memory: memory(),
      model: 'deepseek-chat',
      provider: 'deepseek' as const,
      skillLibrary: library,
    };

    expect(
      names(createTools({...config(), enabledTools: ['read_file']}, deps)),
    ).toEqual(['read_file', 'load_skill']);

    expect(
      names(
        createTools(config(), {
          memory: memory(),
          model: 'deepseek-chat',
          provider: 'deepseek',
        }),
      ),
    ).not.toContain('load_skill');
  });

  it('never attaches the Gemini built-in to a DeepSeek model', () => {
    const tools = createTools(config(), {
      memory: memory(),
      model: 'deepseek-chat',
      provider: 'deepseek',
    });
    expect(names(tools)).not.toContain('google_search');
  });

  it('keeps run_shell behind an approval gate', () => {
    const tools = createTools(config(), {
      memory: memory(),
      model: 'deepseek-chat',
      provider: 'deepseek',
    });
    const shell = tools.find((tool) => tool.name === 'run_shell');
    expect(shell).toBeDefined();
    // A gated tool answers "yes" to the framework's own question.
    return expect(
      shell?.checkRequireConfirmation({command: 'echo hi'}),
    ).resolves.toBe(true);
  });

  describe("a profile's tool selection", () => {
    it('grants only the tools the profile allows', () => {
      const profileConfig = {
        ...config(),
        enabledTools: ['read_file', 'write_file'],
      };
      expect(
        names(
          createTools(profileConfig, {
            memory: memory(),
            model: 'deepseek-chat',
            provider: 'deepseek',
          }),
        ),
      ).toEqual(['read_file', 'write_file']);
    });

    it('treats an empty selection as "no tools", not as "unrestricted"', () => {
      const profileConfig = {...config(), enabledTools: []};
      expect(
        names(
          createTools(profileConfig, {
            memory: memory(),
            model: 'deepseek-chat',
            provider: 'deepseek',
          }),
        ),
      ).toEqual([]);
    });

    it('ignores a name that is not in the catalogue', () => {
      const profileConfig = {
        ...config(),
        enabledTools: ['read_file', 'made_up_tool'],
      };
      expect(
        names(
          createTools(profileConfig, {
            memory: memory(),
            model: 'deepseek-chat',
            provider: 'deepseek',
          }),
        ),
      ).toEqual(['read_file']);
    });
  });

  /**
   * The provider validates every declaration on every request, so one bad
   * keyword fails every turn, not just calls to the offending tool. This is
   * what caught `z.string().min(1)` arriving as `minLength: "1"`.
   */
  it('emits only numbers for numeric schema keywords', () => {
    const tools = createTools(config(), {
      memory: memory(),
      model: 'deepseek-chat',
      provider: 'deepseek',
      webSearch: {search: async () => []},
    });
    const offenders: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (!node || typeof node !== 'object') {
        return;
      }
      for (const [key, value] of Object.entries(
        node as Record<string, unknown>,
      )) {
        if (NUMERIC_SCHEMA_KEYS.has(key) && typeof value !== 'number') {
          offenders.push(`${path}.${key} = ${JSON.stringify(value)}`);
        }
        walk(value, `${path}.${key}`);
      }
    };

    for (const tool of tools) {
      const declaration = tool._getDeclaration();
      expect(declaration).toBeDefined();
      // Through the same mapper the provider uses, so this is the wire shape.
      const [wire] = toOpenAiTools(declaration ? [declaration] : []);
      expect(wire?.function.parameters['type']).toBe('object');
      walk(wire?.function.parameters, tool.name);
    }

    expect(offenders).toEqual([]);
  });
});

const NUMERIC_SCHEMA_KEYS = new Set([
  'maximum',
  'minimum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
  'multipleOf',
]);

/*
 * The list a brand-new profile is granted.
 *
 * Tested against the tools that actually exist, because the failure mode is
 * silent in both directions: a name that no longer matches anything grants
 * nothing and looks like a capability that was never offered, and a name added
 * here by accident is a capability nobody chose.
 */
describe('the safe defaults', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-defaults-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /** Every tool the host can build, with nothing optional left out. */
  function everything(): string[] {
    return createTools(
      {
        baseUrl: 'http://127.0.0.1:1',
        model: 'deepseek-chat',
        provider: 'deepseek',
        apiKey: '',
        systemPrompt: 'test',
        workspaceRoot: workDir,
        allowPrivateNetworkFetch: false,
      },
      {
        memory: new MemoryStore({workspaceRoot: workDir}),
        model: 'deepseek-chat',
        provider: 'deepseek',
        // Present so the web-search name resolves; the defaults name it.
        webSearch: {search: async () => []},
        // And recall, which is a default too — offered, and only *buildable*
        // when the app has an index to answer from.
        recallService: recallStub(),
      },
    ).map((tool) => tool.name);
  }

  it('names only tools that exist', () => {
    const built = new Set(everything());
    const missing = SAFE_DEFAULT_TOOLS.filter((name) => !built.has(name));
    expect(missing).toEqual([]);
  });

  /*
   * The line is not "harmless" but *reach*. Everything in the list can look;
   * nothing in it can change the machine or act in the world. A tool that can do
   * either must not be granted to somebody who has not chosen it.
   */
  it('grants nothing that can act', () => {
    for (const reachable of ['write_file', 'run_shell', 'http_fetch']) {
      expect(SAFE_DEFAULT_TOOLS as readonly string[]).not.toContain(reachable);
    }
  });

  it('grants the things a person would expect an assistant to manage', () => {
    expect(SAFE_DEFAULT_TOOLS).toContain('read_file');
    expect(SAFE_DEFAULT_TOOLS).toContain('web_search');
    expect(SAFE_DEFAULT_TOOLS).toContain('update_memory');
  });
});

/*
 * The settings screen's pick-list.
 *
 * Two failures are possible here and both are silent. A tool without a
 * plain-language description is a checkbox with nothing beside it — a decision
 * nobody can make. A tool the host *builds* but the catalogue does not list can
 * never be granted at all: the switch for it does not exist, and the capability
 * is unreachable while looking like it was never built.
 *
 * The second one was real. The scheduling and skill tools were missing from the
 * catalogue, so an agent with a job service could not be given the tools to use
 * it.
 */
describe('the tool catalogue', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-catalog-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /*
   * DeepSeek on both sides of every comparison below, because the provider is
   * what decides whether `google_search` exists: built with one provider here
   * and described with another, a comparison would report the grounding tool as
   * either unreachable or unlisted when neither is true.
   */
  function config(): AgentConfig {
    return {
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-chat',
      provider: 'deepseek',
      apiKey: '',
      systemPrompt: 'test',
      workspaceRoot: workDir,
      allowPrivateNetworkFetch: false,
    };
  }

  /** Stand-ins. Nothing in a catalogue is executed. */
  function services(): Record<string, unknown> {
    return {
      jobService: {} as never,
      skillService: {} as never,
      discordService: {} as never,
      deskService: {} as never,
      recallService: recallStub(),
      delegate: {
        start: async () => ({problem: 'nothing is resolved here'}),
        pendingGates: async () => [],
      },
    };
  }

  /** Every tool the host can build, when everything is wired. */
  function everything(): string[] {
    return createTools(config(), {
      memory: new MemoryStore({workspaceRoot: workDir}),
      model: 'deepseek-chat',
      provider: 'deepseek',
      webSearch: {search: async () => []},
      ...services(),
    }).map((tool) => tool.name);
  }

  /*
   * The comparison that would have caught it. Building both sides with the same
   * services is what makes this a real check rather than two lists that happen
   * to agree.
   */
  it('lists every tool the host can build', () => {
    const listed = new Set(
      describeTools({
        workspaceRoot: workDir,
        model: 'deepseek-chat',
        provider: 'deepseek',
        webSearch: {search: async () => []},
        delegate: true,
        jobs: true,
        skills: true,
        discord: true,
        desk: true,
        recall: true,
      }).map((entry) => entry.name),
    );

    const unreachable = everything().filter((name) => !listed.has(name));
    expect(unreachable).toEqual([]);
  });

  /*
   * Thrown rather than defaulted, so a tool added without a blurb fails here
   * instead of appearing as a blank line on a settings screen. The message names
   * the tool, because whoever hits it needs to know which one.
   */
  it('describes every tool it lists, in words for a person', () => {
    const entries = describeTools({
      workspaceRoot: workDir,
      model: 'deepseek-chat',
      provider: 'deepseek',
      webSearch: {search: async () => []},
      delegate: true,
      jobs: true,
      skills: true,
      discord: true,
      desk: true,
      recall: true,
    });

    expect(entries).toHaveLength(everything().length);
    for (const entry of entries) {
      /*
       * Not a length threshold: "Write a note." is a perfectly good sentence and
       * a floor high enough to look meaningful would fail it while passing a
       * long piece of jargon. What is checked is that there *is* one, that it is
       * written as a sentence, and — the guard that matters — that it is not
       * simply the model's copy pasted across.
       */
      expect(entry.blurb.trim()).toBe(entry.blurb);
      expect(entry.blurb.endsWith('.')).toBe(true);
      expect(entry.blurb.charAt(0)).toBe(entry.blurb.charAt(0).toUpperCase());
      expect(entry.blurb).not.toBe(entry.description);
    }
  });

  it('marks exactly the safe defaults as granted out of the box', () => {
    const entries = describeTools({
      workspaceRoot: workDir,
      model: 'deepseek-chat',
      provider: 'deepseek',
      webSearch: {search: async () => []},
      jobs: true,
      // Recall is one of the defaults, so the catalogue that checks the defaults
      // has to be built the way an install with recall wired is.
      recall: true,
    });

    const byDefault = entries
      .filter((entry) => entry.byDefault)
      .map((entry) => entry.name);
    expect(new Set(byDefault)).toEqual(new Set(SAFE_DEFAULT_TOOLS));
  });
});

/*
 * The three choices the setup flow offers.
 *
 * The failure this guards against is the one every hand-written list of names
 * eventually has: a tool renamed in the catalogue and not here grants nothing,
 * silently, while the card on screen goes on promising it. So the names are
 * checked against the tools that are actually built — the same comparison the
 * catalogue test above makes, for the same reason.
 */
describe('the capability presets', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(process.cwd(), '.marimo-presets-'));
  });

  afterEach(async () => {
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /** Every tool the host can build, with nothing optional left out. */
  function everything(): Set<string> {
    return new Set(
      createTools(
        {
          baseUrl: 'http://127.0.0.1:1',
          model: 'deepseek-chat',
          provider: 'deepseek',
          apiKey: '',
          systemPrompt: 'test',
          workspaceRoot: workDir,
          allowPrivateNetworkFetch: false,
        },
        {
          memory: new MemoryStore({workspaceRoot: workDir}),
          model: 'deepseek-chat',
          provider: 'deepseek',
          webSearch: {search: async () => []},
          jobService: {} as never,
          skillService: {} as never,
          discordService: {} as never,
          deskService: {} as never,
          recallService: recallStub(),
          delegate: {
            start: async () => ({problem: 'nothing is resolved here'}),
            pendingGates: async () => [],
          },
        },
      ).map((tool) => tool.name),
    );
  }

  it('names only tools that exist', () => {
    const built = everything();
    const missing = CAPABILITY_PRESETS.flatMap((preset) =>
      preset.tools
        .filter((name) => !built.has(name))
        .map((name) => `${preset.id}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  /*
   * The whole reason the presets are allowed to exist. If the recommended card
   * and what a brand-new agent is granted were two lists, the first person to
   * add a tool to one of them would make the card a lie — and the lie would look
   * like a switch that does nothing.
   */
  it('recommends exactly what a brand-new agent is granted', () => {
    const recommended = CAPABILITY_PRESETS.filter(
      (preset) => preset.recommended,
    );
    expect(recommended).toHaveLength(1);
    expect(new Set(recommended[0]!.tools)).toEqual(new Set(SAFE_DEFAULT_TOOLS));
  });

  /*
   * The tiers are reach, and the line is that none of them runs a command on
   * somebody's computer. That is the one capability this app does not hand out
   * as a preset — it lives in Settings beside the switch that explains
   * it.
   */
  it('never grants a shell, and grows by reach', () => {
    for (const preset of CAPABILITY_PRESETS) {
      expect(preset.tools).not.toContain('run_shell');
    }

    const [chat, assistant, capable] = CAPABILITY_PRESETS;
    const contains = (outer: string[], inner: string[]): boolean =>
      inner.every((name) => outer.includes(name));
    expect(contains(assistant!.tools, chat!.tools)).toBe(true);
    expect(contains(capable!.tools, assistant!.tools)).toBe(true);

    // And the growth is real: the simplest card is not the whole catalogue.
    expect(chat!.tools.length).toBeLessThan(capable!.tools.length);
  });

  /*
   * Read as a sentence, like a tool's blurb and for the same reason: this is
   * what somebody deciding has to go on, and "Enable file system access" beside
   * a button is not a decision anybody can make.
   */
  it('describes each choice in words for a person', () => {
    for (const preset of CAPABILITY_PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(preset.label.trim()).toBe(preset.label);
      expect(preset.blurb.trim()).toBe(preset.blurb);
      expect(preset.blurb.endsWith('.')).toBe(true);
      expect(preset.label).not.toBe(preset.blurb);
    }
    expect(new Set(CAPABILITY_PRESETS.map((preset) => preset.id)).size).toBe(
      CAPABILITY_PRESETS.length,
    );
  });
});
