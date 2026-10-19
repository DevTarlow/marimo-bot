/**
 * The Discord tools, against a stand-in connection.
 *
 * The connection itself has its own tests; what matters here is the contract the
 * model is held to: an over-long message is refused before Discord ever sees it,
 * a failure comes back as a sentence the model can act on rather than as a thrown
 * error that ends the turn, reading is free, and the one thing that can post
 * somewhere the user did not choose is the one thing behind the approval gate.
 */
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';

import type {BaseTool, Context} from '@google/adk';
import type {DiscordChannel, DiscordMessage} from '@marimo/protocol';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import type {AgentConfig} from '../config.js';
import {MemoryStore} from '../memory/index.js';
import {
  DISCORD_MESSAGE_LIMIT,
  DISCORD_READ_DEFAULT,
  createListDiscordChannelsTool,
  createReadDiscordMessagesTool,
  createSendDiscordMessageTool,
  discordTools,
} from './discord-tools.js';
import type {DiscordService} from './discord-tools.js';
import {createTools} from './index.js';

const WATCHED = {id: '100', name: 'general'};

const CHANNELS: DiscordChannel[] = [
  {id: '100', name: 'general', guild: 'Marimo Bot HQ'},
  {id: '200', name: 'random', guild: 'Marimo Bot HQ'},
  {id: '300', name: 'alerts', guild: 'Ops'},
];

const MESSAGES: DiscordMessage[] = [
  {
    id: 'm1',
    author: 'Ada',
    content: 'morning',
    createdAt: '2026-05-01T09:00:00.000Z',
    bot: false,
  },
  {
    id: 'm2',
    author: 'Marimo Bot',
    content: 'morning!',
    createdAt: '2026-05-01T09:01:00.000Z',
    bot: true,
  },
];

interface Harness {
  service: DiscordService;
  sent: Array<{channel?: string; text: string; replyTo?: string}>;
  reads: Array<{channel?: string; limit: number}>;
}

function harness(overrides: Partial<DiscordService> = {}): Harness {
  const sent: Harness['sent'] = [];
  const reads: Harness['reads'] = [];
  const service: DiscordService = {
    defaultChannel: () => WATCHED,
    send: async (input) => {
      sent.push(input);
      return {id: 'posted-1', channel: 'general'};
    },
    history: async (input) => {
      reads.push(input);
      return MESSAGES;
    },
    channels: async () => CHANNELS,
    ...overrides,
  };
  return {service, sent, reads};
}

/** Runs a tool through ADK's own validation, as the runner does. */
async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.runAsync({
    args,
    toolContext: {sessionId: 'session-1'} as unknown as Context,
  });
  return typeof result === 'string' ? result : JSON.stringify(result);
}

describe('Discord tools', () => {
  describe('send_discord_message', () => {
    it('posts to the watched channel when no channel is named', async () => {
      const {service, sent} = harness();
      const tool = createSendDiscordMessageTool({discord: service});
      const result = await run(tool, {text: 'hello'});

      expect(sent).toEqual([{text: 'hello'}]);
      expect(result).toContain('the watched channel');
      expect(result).toContain('posted-1');
    });

    it('passes a reply target through, so the answer threads under the mention', async () => {
      const {service, sent} = harness();
      const tool = createSendDiscordMessageTool({discord: service});
      await run(tool, {text: 'yes', replyTo: 'm1'});

      expect(sent[0]?.replyTo).toBe('m1');
    });

    it('refuses a message Discord would reject, without calling Discord', async () => {
      const {service, sent} = harness();
      const tool = createSendDiscordMessageTool({discord: service});
      const result = await run(tool, {
        text: 'x'.repeat(DISCORD_MESSAGE_LIMIT + 1),
      });

      expect(sent).toEqual([]);
      expect(result).toContain('over Discord');
    });

    it('reports a failure as something the model can react to', async () => {
      const {service} = harness({
        send: async () => {
          throw new Error(
            'Discord refused that: the bot cannot see that channel.',
          );
        },
      });
      const tool = createSendDiscordMessageTool({discord: service});
      const result = await run(tool, {text: 'hello'});

      expect(result).toContain('Could not post to Discord');
      expect(result).toContain('cannot see that channel');
    });

    it('asks for approval only when the message goes somewhere else', async () => {
      const tool = createSendDiscordMessageTool({discord: harness().service});

      // The watched channel, by omission and by id: both are where the user
      // pointed the bot.
      await expect(tool.checkRequireConfirmation({text: 'hi'})).resolves.toBe(
        false,
      );
      await expect(
        tool.checkRequireConfirmation({text: 'hi', channel: WATCHED.id}),
      ).resolves.toBe(false);
      // Anywhere else is the user's decision, not the model's.
      await expect(
        tool.checkRequireConfirmation({text: 'hi', channel: '200'}),
      ).resolves.toBe(true);
    });

    /**
     * The mention prompt names the channel ("#general in Marimo Bot HQ"), so a model
     * answering a mention may well repeat it. Treating that as somewhere else
     * asked the user to approve a reply to their own message, which is the bug
     * this pins.
     */
    it('treats the watched channel by name as the watched channel', async () => {
      const tool = createSendDiscordMessageTool({discord: harness().service});

      for (const channel of ['general', '#general', ' General ', '#GENERAL']) {
        await expect(
          tool.checkRequireConfirmation({text: 'hi', channel}),
        ).resolves.toBe(false);
      }
      // A channel whose name merely contains it is still somewhere else.
      await expect(
        tool.checkRequireConfirmation({text: 'hi', channel: 'general-chat'}),
      ).resolves.toBe(true);
      await expect(
        tool.checkRequireConfirmation({text: 'hi', channel: '#random'}),
      ).resolves.toBe(true);
    });

    it('treats an empty channel reference as the watched channel', async () => {
      const tool = createSendDiscordMessageTool({discord: harness().service});
      await expect(
        tool.checkRequireConfirmation({text: 'hi', channel: '   '}),
      ).resolves.toBe(false);
    });

    it('does not gate a send when no channel is configured at all', async () => {
      // Nothing is "the watched channel" yet, so the tool is unusable anyway; it
      // says so on the way through rather than deadlocking on an approval.
      const tool = createSendDiscordMessageTool({
        discord: harness({defaultChannel: () => undefined}).service,
      });
      await expect(tool.checkRequireConfirmation({text: 'hi'})).resolves.toBe(
        false,
      );
    });
  });

  describe('read_discord_messages', () => {
    it('reads the default channel with the documented window', async () => {
      const {service, reads} = harness();
      const tool = createReadDiscordMessagesTool({discord: service});
      const result = await run(tool, {});

      expect(reads).toEqual([{limit: DISCORD_READ_DEFAULT}]);
      expect(result).toContain('id m1 · Ada');
      expect(result).toContain('morning');
      // The agent's own posts are marked, so it can tell them from a person's.
      expect(result).toContain('Marimo Bot (bot)');
    });

    it('says so when the channel is empty', async () => {
      const {service} = harness({history: async () => []});
      const tool = createReadDiscordMessagesTool({discord: service});
      expect(await run(tool, {})).toContain('no messages');
    });

    it('never needs approval', async () => {
      const tool = createReadDiscordMessagesTool({discord: harness().service});
      await expect(
        tool.checkRequireConfirmation({channel: '300', limit: 5}),
      ).resolves.toBe(false);
    });
  });

  describe('list_discord_channels', () => {
    it('lists the channels and marks the watched one', async () => {
      const tool = createListDiscordChannelsTool({discord: harness().service});
      const result = await run(tool, {});

      expect(result).toContain('100 · #general — Marimo Bot HQ (watched)');
      expect(result).toContain('300 · #alerts — Ops');
      expect(result).not.toContain('#random — Marimo Bot HQ (watched)');
    });

    it('says so when the bot is in no server it can post to', async () => {
      const tool = createListDiscordChannelsTool({
        discord: harness({channels: async () => []}).service,
      });
      expect(await run(tool, {})).toContain('not in any server');
    });
  });

  describe('the catalogue', () => {
    let workDir: string;

    beforeEach(async () => {
      workDir = await mkdtemp(join(process.cwd(), '.marimo-discord-'));
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
        profileId: 'profile-1',
        workspaceRoot: workDir,
        allowPrivateNetworkFetch: false,
      };
    }

    it('offers no Discord tools when the app has no connection', () => {
      const tools = createTools(config(), {
        memory: new MemoryStore({workspaceRoot: workDir}),
        provider: 'deepseek',
        model: 'deepseek-chat',
      });
      expect(tools.map((tool) => tool.name)).not.toContain(
        'send_discord_message',
      );
    });

    it('places them after the scheduling tools when a connection exists', () => {
      const jobs = {
        list: async () => [],
        create: async () => {
          throw new Error('not used');
        },
        update: async () => null,
        remove: async () => false,
      };
      const tools = createTools(config(), {
        memory: new MemoryStore({workspaceRoot: workDir}),
        provider: 'deepseek',
        model: 'deepseek-chat',
        jobService: jobs,
        discordService: harness().service,
      });
      expect(tools.map((tool) => tool.name).slice(10)).toEqual([
        'list_jobs',
        'create_job',
        'update_job',
        'delete_job',
        'send_discord_message',
        'read_discord_messages',
        'list_discord_channels',
        'draft_bot',
      ]);
    });

    it('is what a profile picks from, so the names match what is offered', () => {
      const names = discordTools({discord: harness().service}).map(
        (tool) => tool.name,
      );
      expect(names).toEqual([
        'send_discord_message',
        'read_discord_messages',
        'list_discord_channels',
      ]);
    });
  });
});
