/**
 * A Space's documents.
 *
 * What is worth testing here is not the CRUD. It is the three shapes a path can
 * leave a space in and the one refusal they share with the agent's file tools;
 * the conflict a write has to answer instead of overwriting, which is the case
 * the whole revision exists for; and the caps that make a listing say what it
 * could not show. Each of those has a plausible wrong behaviour — a second path
 * checker with a second sentence, a last-write-wins save, a library that
 * quietly stops at five hundred files — which is why they are asserted at that
 * level rather than through the shapes of the objects.
 *
 * The second half is the runtime's own wiring: a space id resolved through the
 * workspaces document, and a saved conversation with every agent named.
 */
import {randomUUID} from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {dirname, join} from 'node:path';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {PathOutsideWorkspaceError, resolveInsideWorkspace} from '@marimo/agent';

import {
  DocumentService,
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH,
  renderChatDocument,
} from './documents.js';
import type {ChatDocument} from './documents.js';
import {resolveAppPaths} from './paths.js';
import type {AppPaths} from './paths.js';
import type {SecretRead} from './secrets.js';
import {AgentRuntime} from './agent/runtime.js';

describe('DocumentService', () => {
  let dir: string;
  let root: string;
  let outside: string;
  let documents: DocumentService;

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-documents-'));
    root = join(dir, 'space');
    outside = join(dir, 'outside');
    await mkdir(root, {recursive: true});
    await mkdir(outside, {recursive: true});
    documents = new DocumentService({root});
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  /** A file in the space, written by the test rather than by the service. */
  async function place(relativePath: string, text: string): Promise<void> {
    const target = join(root, ...relativePath.split('/'));
    await mkdir(dirname(target), {recursive: true});
    await writeFile(target, text, 'utf8');
  }

  function fileIn(relativePath: string): string {
    return join(root, ...relativePath.split('/'));
  }

  /** The error a promise answers with, so a refusal can be inspected. */
  async function refusalOf(run: Promise<unknown>): Promise<Error> {
    try {
      await run;
    } catch (error) {
      return error as Error;
    }
    throw new Error('that was expected to be refused, and was not');
  }

  /**
   * The sentence the agent's own file tools give for a path.
   *
   * Computed with the same exported guard rather than typed out here: "the same
   * refusal" is the assertion, and a copy of the sentence would keep passing
   * after the guard's wording changed.
   */
  async function fileToolRefusal(candidate: string): Promise<string> {
    try {
      await resolveInsideWorkspace(root, candidate);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`"${candidate}" was expected to leave the space.`);
  }

  it('lists the markdown files, nested, and skips the folders nobody means', async () => {
    await place('notes.md', 'at the top');
    await place('docs/guide.md', 'a guide');
    await place('docs/deep/more.markdown', 'deeper');
    await place('docs/notes.txt', 'not a document');
    await place('.marimo/memory.md', "the agent's own memory");
    await place('.git/COMMIT_EDITMSG.md', 'history');
    await place('node_modules/pkg/readme.md', 'a dependency');
    await place('docs/build/output.md', 'generated');

    const {files, notes} = await documents.list();

    expect(files.map((entry) => entry.path)).toEqual([
      'docs/deep/more.markdown',
      'docs/guide.md',
      'notes.md',
    ]);
    expect(notes).toEqual([]);
    const guide = files.find((entry) => entry.path === 'docs/guide.md');
    expect(guide).toMatchObject({
      name: 'guide.md',
      dir: 'docs',
      bytes: Buffer.byteLength('a guide', 'utf8'),
    });
    expect(guide?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    // At the top there is no directory, and the row is drawn from the name.
    expect(files[2]).toMatchObject({name: 'notes.md', dir: ''});
  });

  it('says so when the count cap stopped the listing', async () => {
    await Promise.all(
      Array.from({length: MAX_DOCUMENTS + 1}, (_, index) =>
        place(`note-${String(index).padStart(4, '0')}.md`, 'x'),
      ),
    );

    const {files, notes} = await documents.list();

    expect(files).toHaveLength(MAX_DOCUMENTS);
    expect(notes).toEqual([
      `Showing the first ${MAX_DOCUMENTS} markdown files in this space, and there are more.`,
    ]);
  });

  it('says so when a folder was too deep to walk', async () => {
    const levels = Array.from(
      {length: MAX_DOCUMENT_DEPTH},
      (_, index) => `d${String(index)}`,
    );
    // A document at exactly the depth the walk reaches, and one below it.
    await place(`${levels.join('/')}/found.md`, 'at the limit');
    await place(`${[...levels, 'deeper'].join('/')}/lost.md`, 'below it');

    const {files, notes} = await documents.list();

    expect(files.map((entry) => entry.path)).toEqual([
      `${levels.join('/')}/found.md`,
    ]);
    expect(notes).toEqual([
      `Folders more than ${MAX_DOCUMENT_DEPTH} levels below this space were not opened, so any documents in them are not listed.`,
    ]);
  });

  /*
   * Invariant 6, from the documents side: `..`, an absolute path and a symlink
   * that leaves the space are one refusal, and it is the sentence the agent's
   * own file tools give — because it is the same guard, not a second one that
   * happens to agree today.
   */
  it('refuses a path that leaves the space, in all three shapes', async () => {
    await writeFile(join(outside, 'elsewhere.md'), 'not yours', 'utf8');
    await symlink(join(outside, 'elsewhere.md'), join(root, 'escape.md'));
    await symlink(outside, join(root, 'escape-dir'));

    const candidates = [
      '../outside/elsewhere.md',
      join(outside, 'elsewhere.md'),
      'escape.md',
      'escape-dir/elsewhere.md',
    ];
    for (const candidate of candidates) {
      const error = await refusalOf(documents.read(candidate));
      expect(error).toBeInstanceOf(PathOutsideWorkspaceError);
      expect(error.message).toBe(await fileToolRefusal(candidate));
    }

    // A write and a create are the same door, so they give the same refusal.
    const written = await refusalOf(
      documents.write('../outside/elsewhere.md', 'x', {
        bytes: 0,
        modifiedAtMs: 0,
      }),
    );
    expect(written.message).toBe(
      await fileToolRefusal('../outside/elsewhere.md'),
    );
    const created = await refusalOf(documents.create('..', 'new.md'));
    expect(created.message).toBe(await fileToolRefusal('../new.md'));
  });

  it('refuses a document over the cap rather than returning it', async () => {
    await place('huge.md', 'x'.repeat(MAX_DOCUMENT_BYTES + 1));
    await place('fine.md', 'short');

    await expect(documents.read('huge.md')).rejects.toThrow(
      new RegExp(`capped at ${MAX_DOCUMENT_BYTES} bytes`, 'u'),
    );
    await expect(documents.read('fine.md')).resolves.toMatchObject({
      path: 'fine.md',
      text: 'short',
    });
  });

  it('refuses a file that is not a markdown document, and one that is gone', async () => {
    await place('notes.txt', 'plain');

    await expect(documents.read('notes.txt')).rejects.toThrow(
      /not a markdown document/u,
    );
    await expect(documents.read('missing.md')).rejects.toThrow(
      /There is no document at "missing.md"/u,
    );

    /*
     * A folder wearing a document's name. `open` succeeds on a directory here,
     * so this check is what turns the EISDIR that would arrive from reading one
     * into a sentence about what the path actually is.
     */
    await mkdir(fileIn('folder.md'));
    await expect(documents.read('folder.md')).rejects.toThrow(
      /"folder.md" is a folder, not a document/u,
    );
  });

  /*
   * The case the revision exists for. The file changed under the editor, so the
   * write is answered with a conflict *and the revision now on disk* — the
   * editor's next attempt is based on that — and the other writer's text is
   * still there afterwards, byte for byte and stamp for stamp.
   */
  it('answers a conflict, and writes nothing, when the document moved on', async () => {
    await place('notes.md', 'as it was\n');
    const read = await documents.read('notes.md');

    await place('notes.md', 'changed underneath, and longer\n');
    const before = await stat(fileIn('notes.md'));

    const answer = await documents.write(
      'notes.md',
      'my draft\n',
      read.revision,
    );

    if (answer.ok) {
      throw new Error('the stale write was expected to be refused');
    }
    expect(answer.conflict).toBe(true);
    expect(answer.revision).toEqual({
      bytes: before.size,
      modifiedAtMs: before.mtimeMs,
    });
    // The revision it carries is the one a fresh read answers.
    expect(answer.revision).toEqual(
      (await documents.read('notes.md')).revision,
    );
    expect(await readFile(fileIn('notes.md'), 'utf8')).toBe(
      'changed underneath, and longer\n',
    );
    const after = await stat(fileIn('notes.md'));
    expect({bytes: after.size, modifiedAtMs: after.mtimeMs}).toEqual({
      bytes: before.size,
      modifiedAtMs: before.mtimeMs,
    });
  });

  it('writes when the revision matches, and answers what is now on disk', async () => {
    await place('notes.md', 'first\n');
    const read = await documents.read('notes.md');

    const answer = await documents.write('notes.md', 'second\n', read.revision);

    expect(answer.ok).toBe(true);
    expect(await readFile(fileIn('notes.md'), 'utf8')).toBe('second\n');
    expect(answer.ok && answer.revision).toEqual(
      (await documents.read('notes.md')).revision,
    );
  });

  /*
   * The convention for a file that is not there, spelled out: zero bytes and the
   * epoch mean "I am making this", and anything else is a caller that read
   * something which has since gone — answered with the revision that is actually
   * on disk, which for a missing file is the zero one.
   */
  it('writes a file that is not there only for the zero revision', async () => {
    const stale = await documents.write('fresh.md', 'x\n', {
      bytes: 12,
      modifiedAtMs: 1,
    });
    if (stale.ok) {
      throw new Error(
        'a revision for a file that is gone was expected to conflict',
      );
    }
    expect(stale.revision).toEqual({bytes: 0, modifiedAtMs: 0});

    const answer = await documents.write('fresh.md', 'new\n', {
      bytes: 0,
      modifiedAtMs: 0,
    });
    expect(answer.ok).toBe(true);
    expect(await readFile(fileIn('fresh.md'), 'utf8')).toBe('new\n');
  });

  /*
   * The observable half of "atomic", without simulating a crash. A write that
   * opened the document and replaced its contents would keep the inode and could
   * be caught half-written; this one writes a file beside it and renames, so the
   * original inode is never the one being written and nothing is left behind.
   */
  it('never writes the document in place', async () => {
    await place('notes.md', 'first\n');
    const before = await stat(fileIn('notes.md'));
    const read = await documents.read('notes.md');

    const answer = await documents.write('notes.md', 'second\n', read.revision);
    expect(answer.ok).toBe(true);

    const after = await stat(fileIn('notes.md'));
    expect(after.ino).not.toBe(before.ino);
    expect(
      (await readdir(root)).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
  });

  it('leaves the document alone when a temporary file never became it', async () => {
    // The state a crash between the write and the rename leaves behind, built
    // rather than simulated: the temp file is there, the document never heard of
    // it, and the library does not list debris.
    await place('notes.md', 'the original\n');
    await writeFile(
      fileIn(`notes.md.${randomUUID()}.tmp`),
      'half a draft',
      'utf8',
    );

    const {files} = await documents.list();

    expect(files.map((entry) => entry.path)).toEqual(['notes.md']);
    await expect(documents.read('notes.md')).resolves.toMatchObject({
      text: 'the original\n',
    });
  });

  /*
   * The write cap is the read cap from the other end: a document this service
   * would refuse to open must not be one it can save, or a save would produce a
   * file the editor cannot read back.
   */
  it('refuses to save a document it could not open again', async () => {
    await place('notes.md', 'small\n');
    const read = await documents.read('notes.md');

    await expect(
      documents.write(
        'notes.md',
        'x'.repeat(MAX_DOCUMENT_BYTES + 1),
        read.revision,
      ),
    ).rejects.toThrow(new RegExp(`capped at ${MAX_DOCUMENT_BYTES} bytes`, 'u'));
    expect(await readFile(fileIn('notes.md'), 'utf8')).toBe('small\n');
  });

  /*
   * A missing folder is a refusal rather than `mkdir -p`. The folder is the
   * user's, and a write that invents a tree hides a mistyped or stale path
   * behind a directory nobody asked for.
   */
  it('refuses to write into a folder the space does not have', async () => {
    await expect(
      documents.write('notes/today.md', 'x\n', {bytes: 0, modifiedAtMs: 0}),
    ).rejects.toThrow(/has no folder "notes"/u);
    await expect(documents.create('notes', 'today.md')).rejects.toThrow(
      /has no folder "notes"/u,
    );
  });

  it('creates a document that is not there, and refuses one that is', async () => {
    await mkdir(fileIn('docs'));

    const created = await documents.create('docs', 'guide.md');
    expect(created).toMatchObject({path: 'docs/guide.md', text: ''});
    expect(await readFile(fileIn('docs/guide.md'), 'utf8')).toBe('');

    await expect(documents.create('docs', 'guide.md')).rejects.toThrow(
      /already exists/u,
    );
    await expect(
      documents.create(undefined, 'at-the-top.md'),
    ).resolves.toMatchObject({path: 'at-the-top.md'});
  });

  it('refuses a name that is not a document name', async () => {
    for (const name of ['notes', 'notes.txt', '..', 'docs/guide.md']) {
      await expect(documents.create(undefined, name)).rejects.toThrow(
        /is not a (markdown file|document) name/u,
      );
    }
  });

  it('renders a conversation under each author, and skips an empty turn', () => {
    const markdown = renderChatDocument({
      title: 'Parser output',
      savedAt: new Date(2026, 1, 3, 12, 0, 0),
      messages: [
        {author: 'You', text: 'show me the parser output'},
        {author: 'Marimo Bot', text: 'Here it is.'},
        {author: 'Researcher', text: 'I checked the tokens.'},
        {author: 'Marimo Bot', text: '   '},
      ],
    });

    expect(markdown).toContain('# Parser output');
    expect(markdown).toContain('Saved on 2026-02-03.');
    expect(markdown).toContain('## You\n\nshow me the parser output');
    expect(markdown).toContain('## Marimo Bot\n\nHere it is.');
    expect(markdown).toContain('## Researcher\n\nI checked the tokens.');
    // A turn that only called a tool is not a heading with nothing under it.
    expect(markdown.match(/^## Marimo Bot$/gmu)).toHaveLength(1);
  });

  it('saves a conversation into the space, and refuses a name already taken', async () => {
    await mkdir(fileIn('chats'));
    const chat: ChatDocument = {
      title: 'A chat',
      savedAt: new Date(2026, 0, 1),
      messages: [{author: 'You', text: 'hello'}],
    };

    const saved = await documents.saveChat('chats/2026-01-01.md', chat);
    expect(saved.path).toBe('chats/2026-01-01.md');
    expect(await readFile(fileIn('chats/2026-01-01.md'), 'utf8')).toBe(
      renderChatDocument(chat),
    );

    await expect(
      documents.saveChat('chats/2026-01-01.md', chat),
    ).rejects.toThrow(/never overwrites a document/u);
    expect(await readFile(fileIn('chats/2026-01-01.md'), 'utf8')).toBe(
      renderChatDocument(chat),
    );
  });
});

describe('AgentRuntime documents', () => {
  let dir: string;
  let paths: AppPaths;
  let runtime: AgentRuntime;

  const sessionId = 'parser-chat';

  /**
   * One stored event, in the shape the session service writes.
   *
   * `a_researcher` is the author ADK builds a helper under, and the id has no
   * dash or underscore for the name's escapes to rewrite — so what the
   * transcript projects back is plainly `researcher`.
   */
  function stored(author: string, role: string, text: string): string {
    return JSON.stringify({
      author,
      content: {role, parts: [{text}]},
      id: `event-${author}-${String(text.length)}`,
      invocationId: '',
      actions: {
        stateDelta: {},
        artifactDelta: {},
        requestedAuthConfirmation: {},
        requestedToolConfirmations: {},
      },
      longRunningToolIds: [],
      timestamp: Date.now(),
    });
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), '.marimo-docs-runtime-'));
    paths = resolveAppPaths(dir);
    await mkdir(join(dir, 'chats'), {recursive: true});
    await writeFile(
      paths.workspaces,
      `${JSON.stringify({
        version: 1,
        workspaces: [{id: 'space', name: 'space', path: dir}],
        activeWorkspaceId: 'space',
      })}\n`,
      'utf8',
    );
    await writeFile(
      paths.profiles,
      `${JSON.stringify({
        version: 1,
        activeProfileId: 'marimo',
        profiles: [
          {
            id: 'marimo',
            name: 'Marimo Bot',
            identity: '',
            enabledTools: [],
            enabledSkills: [],
          },
          {
            id: 'researcher',
            name: 'Researcher',
            identity: '',
            enabledTools: [],
            enabledSkills: [],
          },
        ],
      })}\n`,
      'utf8',
    );

    await mkdir(paths.sessions, {recursive: true});
    await writeFile(
      join(paths.sessions, `${sessionId}.jsonl`),
      `${[
        stored('user', 'user', 'show me the parser output'),
        stored('marimo', 'model', 'Here it is.'),
        stored('a_researcher', 'model', 'I checked the tokens.'),
      ].join('\n')}\n`,
      'utf8',
    );
    await writeFile(
      join(paths.sessions, 'index.json'),
      `${JSON.stringify({
        version: 1,
        sessions: {
          [sessionId]: {
            id: sessionId,
            title: 'Parser output',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 3,
            appName: 'marimo',
            userId: 'local',
            profileId: 'marimo',
          },
        },
      })}\n`,
      'utf8',
    );

    // No key at all: nothing here needs a model, and the refusal cases go
    // through paths that must not ask for one.
    const noKey = async (): Promise<SecretRead> => ({state: 'absent'});
    runtime = new AgentRuntime({paths, readSecret: noKey});
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  });

  it('refuses a space nobody has, in a sentence', async () => {
    await expect(runtime.documentsFor('gone')).rejects.toThrow(
      'There is no space called "gone". It may have been removed from the list.',
    );
  });

  it('reads and writes a document by space id', async () => {
    await writeFile(join(dir, 'notes.md'), 'hello\n', 'utf8');

    const read = await runtime.readDocument('space', 'notes.md');
    expect(read.text).toBe('hello\n');

    const answer = await runtime.writeDocument(
      'space',
      'notes.md',
      'changed\n',
      read.revision,
    );
    expect(answer.ok).toBe(true);
    expect(await readFile(join(dir, 'notes.md'), 'utf8')).toBe('changed\n');
  });

  /*
   * The rule that makes a saved chat more than a transcript dump: a helper's
   * words are written under the helper's name. The lead's are not tagged in the
   * stored events, so they answer to the conversation's own agent.
   */
  it('saves a conversation with every agent under its own name', async () => {
    const saved = await runtime.saveChatAsDocument(
      'marimo',
      sessionId,
      'space',
      'chats/parser-output.md',
    );

    expect(saved.path).toBe('chats/parser-output.md');
    const markdown = await readFile(
      join(dir, 'chats', 'parser-output.md'),
      'utf8',
    );
    expect(markdown).toContain('# Parser output');
    expect(markdown).toMatch(/Saved on \d{4}-\d{2}-\d{2}\./u);
    expect(markdown).toContain('## You\n\nshow me the parser output');
    expect(markdown).toContain('## Marimo Bot\n\nHere it is.');
    expect(markdown).toContain('## Researcher\n\nI checked the tokens.');
  });

  it('refuses to save a conversation over a document already there', async () => {
    await runtime.saveChatAsDocument(
      'marimo',
      sessionId,
      'space',
      'chats/one.md',
    );

    await expect(
      runtime.saveChatAsDocument('marimo', sessionId, 'space', 'chats/one.md'),
    ).rejects.toThrow(/already exists/u);
  });

  it('refuses a conversation the index does not have', async () => {
    await expect(
      runtime.saveChatAsDocument(
        'marimo',
        'no-such-chat',
        'space',
        'chats/x.md',
      ),
    ).rejects.toThrow(/no conversation called "no-such-chat"/u);
  });
});
