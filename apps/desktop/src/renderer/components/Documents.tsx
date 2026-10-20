/**
 * The documents drawer: the files in the conversation's Space, and an editor for
 * the text ones.
 *
 * The third column, and the only thing in it. It is opened from the header and
 * closed from the header, and while it is open it is a column of its own rather
 * than an overlay: a person editing a file wants to see the conversation beside
 * it, which is the whole reason documents are worth having in this app.
 *
 * What it deliberately is not: a file manager, a watcher, or a second place a
 * turn is started. It lists what `docs.list` sent, reads one file at a time,
 * and writes it back only through `docs.write`, whose whole design is that a
 * file which moved underneath the editor is a question rather than a silent
 * overwrite. A binary file is listed too, and the read that refuses it is the
 * sentence the library shows: nothing is opened and nothing is written. The
 * conflict path below is the point of the feature; everything else is the
 * machinery that gets a person to it.
 *
 * It stays mounted while closed, and that is deliberate: a draft typed in the
 * last second before the drawer is shut still has an autosave coming, and
 * unmounting would drop it with the timer.
 */
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import type {
  AgentUiEvent,
  DocumentEntry,
  DocumentRead,
  Workspace,
} from '@marimo/protocol';

import {formatBytes} from '../bytes.js';
import {describe} from '../describe.js';
import {
  afterWrite,
  clampDocumentsWidth,
  filterFiles,
  groupFiles,
  isMarkdownPath,
  MAX_DOCUMENTS_WIDTH,
  MIN_DOCUMENTS_WIDTH,
  modifiedLabel,
  suggestChatName,
} from '../documents.js';
import type {OpenDocument} from '../documents.js';
import {Markdown} from './Markdown.js';

import './documents.css';

/** How long typing settles before the draft is written. */
const AUTOSAVE_MS = 800;

/** Which half of the editor is showing. */
type Mode = 'edit' | 'preview';

/** What the last write did, for the quiet line above the text. */
type Status = 'idle' | 'saving' | 'saved' | 'failed';

/** Which of the two "name a file" forms is open, if either. */
type Naming = 'none' | 'new' | 'chat';

export function Documents({
  open,
  space,
  profileId,
  sessionId,
  sessionTitle,
  hasConversation,
  width,
  onResize,
  onResizeEnd,
  onClose,
}: {
  open: boolean;
  /** The space the drawer is about, or none when this install has no Space. */
  space: Workspace | null;
  profileId: string | undefined;
  sessionId: string | null;
  sessionTitle: string | undefined;
  /** Whether the open conversation has anything in it worth writing down. */
  hasConversation: boolean;
  /** The drawer's live width, in pixels. */
  width: number;
  /** Applies a width while the handle is moving. */
  onResize: (width: number) => void;
  /** Writes the width the drag settled on, so it survives a restart. */
  onResizeEnd: (width: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [files, setFiles] = useState<DocumentEntry[] | null>(null);
  /**
   * What the server said about the listing it sent: a cap it stopped at, a
   * folder it did not open. Drawn above the rows they are about.
   */
  const [listNotes, setListNotes] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<OpenDocument | null>(null);
  const [mode, setMode] = useState<Mode>('edit');
  const [status, setStatus] = useState<Status>('idle');
  /**
   * The write was refused because the file moved on.
   *
   * A boolean rather than the revision the server answered with: the way out of
   * this is to read the file again, so the newest revision is fetched at the
   * moment of the choice rather than kept from the moment of the refusal.
   */
  const [conflict, setConflict] = useState(false);
  /** A failure of the library or of one of the two actions. */
  const [problem, setProblem] = useState<string | null>(null);
  /** A failure of the editor: a read or a write. */
  const [editorProblem, setEditorProblem] = useState<string | null>(null);
  const [naming, setNaming] = useState<Naming>('none');
  const [nameDraft, setNameDraft] = useState('');
  /** A create or a save-chat is in flight. */
  const [working, setWorking] = useState(false);
  /** Whether the drawer's left edge is being dragged, so it can stay lit. */
  const [resizing, setResizing] = useState(false);

  /*
   * The values the async paths need, readable at the moment they resume. A
   * closure over the state would be a render behind by then — which for a write
   * means sending the text from before the last keystroke.
   */
  const openRef = useRef(open);
  openRef.current = open;
  const spaceRef = useRef(space);
  spaceRef.current = space;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  const editorRef = useRef<OpenDocument | null>(editor);
  editorRef.current = editor;

  /** The newest library read, so a slow one cannot overwrite a newer one. */
  const listSequence = useRef(0);
  /** The newest file open, for the same reason. */
  const openSequence = useRef(0);
  /**
   * The writes, in one line.
   *
   * Two overlapping writes would both carry the revision from before the other
   * — the second would come back a conflict nobody caused, and a person would be
   * asked to choose between their own draft and their own draft. Queueing also
   * gives "save, then switch file" its order for free.
   */
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  /*
   * The body class the drag puts on the whole window has to come off on every
   * path out, including this component disappearing mid-drag.
   */
  useEffect(
    () => () => {
      document.body.classList.remove('resizing-documents');
    },
    [],
  );

  /**
   * The drag in flight.
   *
   * `startWidth` is measured from the element rather than taken from the prop,
   * so a column the window clamped is the width the pointer starts from and the
   * first move does not jump.
   */
  const drag = useRef<{
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);

  const refreshList = useCallback(async (): Promise<void> => {
    const space = spaceRef.current;
    if (space === null) {
      return;
    }
    const id = space.id;
    const mine = listSequence.current + 1;
    listSequence.current = mine;
    try {
      const answer = await window.marimo.call('docs.list', {spaceId: id});
      // Dropped when a newer read has been asked for, or the drawer has moved
      // to another Space: either way these are another folder's files.
      if (listSequence.current !== mine || spaceRef.current?.id !== id) {
        return;
      }
      setFiles(answer.files);
      /*
       * The server's own sentences about the listing it sent — the cap it
       * stopped at, the folders it did not open. Printed rather than
       * interpreted: whether something was dropped is a fact about the read, and
       * the process that did the read is the one that knows it.
       */
      setListNotes(answer.notes);
      setProblem(null);
    } catch (failure) {
      if (listSequence.current !== mine) {
        return;
      }
      setProblem(describe(failure));
    }
  }, []);

  /*
   * The library is re-read when the drawer opens, and when the Space it is
   * about changes — which is not a thing the person does to the drawer, but it
   * is a thing that happens to it.
   */
  useEffect(() => {
    if (!open || space === null) {
      return;
    }
    void refreshList();
  }, [open, space, refreshList]);

  /*
   * A turn ending is the one moment a file can appear without this window doing
   * anything: the agent writes with its own tools, into the same folder, and
   * this app has no watcher to notice. The open conversation only — a turn
   * elsewhere did not touch the files being listed.
   */
  useEffect(() => {
    const off = window.marimo.onEvent((event: AgentUiEvent) => {
      if (event.type !== 'turn.completed') {
        return;
      }
      if (!openRef.current || event.sessionId !== sessionRef.current) {
        return;
      }
      void refreshList();
    });
    return off;
  }, [refreshList]);

  /*
   * Opening another Space drops what belonged to the old one: the library, the
   * filter, and an unfinished name. The *editor* survives, with the space it was
   * opened in, because a draft is somebody's words — see `OpenDocument`.
   */
  const lastSpace = useRef<string | null>(space?.id ?? null);
  useEffect(() => {
    const id = space?.id ?? null;
    if (lastSpace.current === id) {
      return;
    }
    lastSpace.current = id;
    setFiles(null);
    setListNotes([]);
    setQuery('');
    setNaming('none');
    setProblem(null);
  }, [space]);

  /**
   * One write, of the draft the editor holds at the moment it runs.
   *
   * Answers whether the editor is safe to leave: true when there was nothing to
   * write or the file now holds the draft.
   */
  const writeDraft = useCallback(async (): Promise<boolean> => {
    const doc = editorRef.current;
    if (doc === null || doc.text === doc.saved) {
      return true;
    }
    const text = doc.text;
    const path = doc.path;
    const spaceId = doc.spaceId;
    setStatus('saving');
    try {
      const answer = await window.marimo.call('docs.write', {
        spaceId,
        path,
        text,
        revision: doc.revision,
      });
      const current = editorRef.current;
      if (
        current === null ||
        current.path !== path ||
        current.spaceId !== spaceId
      ) {
        // Closed, or another file opened, while this was in flight. The answer
        // belongs to the file it named, and there is nothing on screen to say
        // it about.
        return true;
      }
      /*
       * What the answer means for the draft is `afterWrite`, in one place for
       * both the ordinary write and the forced one below — including the rule
       * that a refusal changes nothing on screen.
       */
      const outcome = afterWrite(current, text, answer);
      setEditor(outcome.document);
      setConflict(outcome.conflict);
      setStatus(outcome.conflict ? 'idle' : 'saved');
      if (!outcome.conflict) {
        setEditorProblem(null);
      }
      return !outcome.conflict;
    } catch (failure) {
      /*
       * The failure belongs to the file it was about. Somebody can switch rows
       * while a write is in flight, and a sentence about a file that is no
       * longer on screen under the one that is would be read as a failure of the
       * wrong document.
       */
      const current = editorRef.current;
      if (
        current !== null &&
        current.path === path &&
        current.spaceId === spaceId
      ) {
        setEditorProblem(describe(failure));
        setStatus('failed');
      }
      return false;
    }
  }, []);

  const save = useCallback((): Promise<boolean> => {
    const run = writes.current.then(writeDraft, writeDraft);
    writes.current = run.catch(() => undefined);
    return run;
  }, [writeDraft]);

  /*
   * Autosave, on idle.
   *
   * Not armed while a conflict is up: the file has a newer version than the
   * draft is based on, so every write from here would be refused — a refusal
   * asked for on a loop, behind a banner that says the next move is the
   * person's. Typing keeps working meanwhile, and the draft keeps growing.
   */
  useEffect(() => {
    if (editor === null || conflict || editor.text === editor.saved) {
      return;
    }
    const timer = setTimeout(() => {
      void save();
    }, AUTOSAVE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [editor, conflict, save]);

  /*
   * The same save, now. Left on the window rather than on the textarea so it
   * works from the preview too, and skipped entirely when there is no file open
   * — a shortcut that swallows the key while nothing can happen is worse than
   * one that does nothing.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 's'
      ) {
        return;
      }
      if (editorRef.current === null) {
        return;
      }
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, save]);

  /*
   * A draft does not die with the component. Settings and the recall offer
   * replace the whole window, so this one is unmounted by things that have
   * nothing to do with it — and a sentence typed in the second before one of
   * them opened would otherwise be dropped with the timer that was going to
   * write it. The write outlives the component, which is what matters; its
   * answers land on state nobody is drawing any more.
   */
  useEffect(
    () => () => {
      void save();
    },
    [save],
  );

  /** Puts a document the server just handed back on screen. */
  const adopt = useCallback((into: Workspace, doc: DocumentRead): void => {
    openSequence.current += 1;
    // A file that opened is the answer to whatever row failed before it, so the
    // refusal sentence above the library does not outlive the attempt.
    setProblem(null);
    setEditor({
      spaceId: into.id,
      spaceName: into.name,
      path: doc.path,
      text: doc.text,
      saved: doc.text,
      revision: doc.revision,
    });
    setConflict(false);
    setEditorProblem(null);
    setStatus('idle');
  }, []);

  const openDocument = useCallback(
    async (path: string): Promise<void> => {
      const space = spaceRef.current;
      if (space === null) {
        return;
      }
      /*
       * Another file is not consent to lose this one. The draft goes out first,
       * and a write that was refused stops the switch: the conflict banner
       * belongs to the file it is about, and moving on would take it off screen
       * with the draft still behind it.
       */
      if (!(await save())) {
        return;
      }
      const mine = openSequence.current + 1;
      openSequence.current = mine;
      try {
        const doc = await window.marimo.call('docs.read', {
          spaceId: space.id,
          path,
        });
        if (openSequence.current !== mine) {
          return;
        }
        adopt(space, doc);
      } catch (failure) {
        if (openSequence.current !== mine) {
          return;
        }
        /*
         * The library's line rather than the editor's: what failed was a row in
         * the list, and there may be no editor on screen at all — a failure the
         * window has nowhere to draw is the one kind it may not have.
         */
        setProblem(describe(failure));
      }
    },
    [adopt, save],
  );

  /** Closes the editor, with the same rule as opening another file. */
  const closeDocument = useCallback(async (): Promise<void> => {
    if (!(await save())) {
      return;
    }
    openSequence.current += 1;
    setEditor(null);
    setConflict(false);
    setEditorProblem(null);
    setStatus('idle');
  }, [save]);

  /**
   * Takes the file's version, losing the draft.
   *
   * Offered as a button rather than done automatically, and this is the whole
   * reason the conflict path exists: the window cannot know whether the newer
   * file or the sentence somebody just typed is the one they want, and choosing
   * for them is how a feature like this loses work. Reload is the half that
   * *does* lose something, so it is the half that says so on the button.
   */
  const reloadDocument = useCallback(async (): Promise<void> => {
    const doc = editorRef.current;
    if (doc === null) {
      return;
    }
    try {
      const fresh = await window.marimo.call('docs.read', {
        spaceId: doc.spaceId,
        path: doc.path,
      });
      const current = editorRef.current;
      if (current === null || current.path !== doc.path) {
        return;
      }
      setEditor({
        ...current,
        text: fresh.text,
        saved: fresh.text,
        revision: fresh.revision,
      });
      setConflict(false);
      setEditorProblem(null);
      setStatus('idle');
    } catch (failure) {
      // Only when the editor still holds this file: a read that failed for one
      // somebody has since closed has nothing to say on screen.
      if (editorRef.current?.path === doc.path) {
        setEditorProblem(describe(failure));
      }
    }
  }, []);

  /**
   * Keeps the draft and writes it anyway.
   *
   * The fresh revision is read first, because that is what "overwrite" has to
   * mean: `docs.write` is a compare-and-set, and forcing it is reading what the
   * file is now and writing the draft against *that*. A second refusal here
   * means somebody wrote again in between, and the offer simply stands.
   */
  const overwriteDocument = useCallback((): Promise<void> => {
    const doc = editorRef.current;
    if (doc === null) {
      return Promise.resolve();
    }
    const force = async (): Promise<void> => {
      setStatus('saving');
      try {
        const fresh = await window.marimo.call('docs.read', {
          spaceId: doc.spaceId,
          path: doc.path,
        });
        const current = editorRef.current;
        if (current === null || current.path !== doc.path) {
          return;
        }
        // The draft as it stands *now*, including anything typed while the file
        // was being read.
        const text = current.text;
        const answer = await window.marimo.call('docs.write', {
          spaceId: doc.spaceId,
          path: doc.path,
          text,
          revision: fresh.revision,
        });
        const latest = editorRef.current;
        if (latest === null || latest.path !== doc.path) {
          return;
        }
        // The same rule as an ordinary write, so a forced one cannot end any
        // differently: a second refusal keeps the draft and the offer.
        const outcome = afterWrite(latest, text, answer);
        setEditor(outcome.document);
        setConflict(outcome.conflict);
        if (outcome.conflict) {
          setStatus('idle');
          return;
        }
        setEditorProblem(null);
        setStatus('saved');
      } catch (failure) {
        // As above: a failure belongs to the file it was about, and this one may
        // not be the file on screen any more.
        if (editorRef.current?.path === doc.path) {
          setEditorProblem(describe(failure));
          setStatus('failed');
        }
      }
    };
    const run = writes.current.then(force, force);
    writes.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Starts a drag from the drawer's current left edge. */
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current !== null) {
      return;
    }
    event.preventDefault();
    // `preventDefault` stops the click from selecting text; focus still has to
    // be put back on the handle so a drag can be followed by the arrow keys.
    event.currentTarget.focus();
    const startWidth =
      event.currentTarget.parentElement?.getBoundingClientRect().width ?? width;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {startX: event.clientX, startWidth, width: startWidth};
    // The cursor has to stay a resize cursor while the pointer is over the
    // conversation, which is the half of the window the drag spends its time in.
    document.body.classList.add('resizing-documents');
    setResizing(true);
  };

  const moveResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === null) {
      return;
    }
    // The drawer's left edge moving left makes it wider.
    const next = clampDocumentsWidth(
      current.startWidth + (current.startX - event.clientX),
    );
    current.width = next;
    onResize(next);
  };

  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current;
    if (current === null) {
      return;
    }
    drag.current = null;
    document.body.classList.remove('resizing-documents');
    setResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizeEnd(current.width);
  };

  /**
   * Arrow keys move the edge by a line, Shift by a wider step. A resize handle
   * that only answers a mouse is a control half the users cannot operate.
   */
  const resizeByKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 48 : 16;
    let next: number;
    if (event.key === 'ArrowLeft') {
      next = clampDocumentsWidth(width + step);
    } else if (event.key === 'ArrowRight') {
      next = clampDocumentsWidth(width - step);
    } else {
      return;
    }
    event.preventDefault();
    onResize(next);
    onResizeEnd(next);
  };

  const beginNaming = (which: Naming): void => {
    setNaming(which);
    setNameDraft(which === 'chat' ? suggestChatName(sessionTitle ?? '') : '');
  };

  /**
   * Creates a file, or writes this conversation into one, then opens it.
   *
   * Both halves end the same way: whatever the server produced is on screen and
   * the library has it, because the point of either is the file rather than the
   * confirmation.
   */
  const submitName = async (): Promise<void> => {
    const space = spaceRef.current;
    const value = nameDraft.trim();
    if (space === null || naming === 'none' || working || value.length === 0) {
      return;
    }
    setWorking(true);
    try {
      /*
       * The rule every path that points the editor somewhere else follows: what
       * is in it goes out first, and a write that was refused stops the move.
       * Both of these actions put a different file on screen, and the draft in
       * the old one would go with it.
       */
      if (!(await save())) {
        return;
      }
      if (naming === 'chat') {
        if (profileId === undefined || sessionId === null) {
          return;
        }
        adopt(
          space,
          await window.marimo.call('docs.saveChat', {
            profileId,
            sessionId,
            spaceId: space.id,
            path: value,
          }),
        );
      } else {
        adopt(
          space,
          await window.marimo.call('docs.create', {
            spaceId: space.id,
            name: value,
          }),
        );
      }
      setNaming('none');
      setProblem(null);
      await refreshList();
    } catch (failure) {
      setProblem(describe(failure));
    } finally {
      setWorking(false);
    }
  };

  const visible = useMemo(
    () => filterFiles(files ?? [], query),
    [files, query],
  );
  const groups = useMemo(() => groupFiles(visible), [visible]);
  const draft = editor?.text ?? '';
  const dirty = editor !== null && editor.text !== editor.saved;
  /** Only markdown has a rendered view; every other text file is source only. */
  const previewable = editor !== null && isMarkdownPath(editor.path);
  /** The line under the file name: what just happened, in as few words. */
  const stateLine = conflict
    ? 'Your draft is not saved.'
    : status === 'saving'
      ? 'Saving…'
      : editorProblem !== null
        ? editorProblem
        : dirty
          ? 'Unsaved changes'
          : status === 'saved'
            ? 'Saved'
            : null;

  return (
    <aside
      className="documents"
      aria-label="Documents"
      hidden={!open}
      // Read by the stylesheet: with a file open the library gives part of the
      // column to the editor. An attribute rather than `:has`, so the layout is
      // stated where the editor is decided rather than inferred from the tree.
      data-editor={editor === null ? undefined : 'true'}
    >
      {/*
        The drawer's left edge, and the only pointer target that is not content.
        It sits on the aside's inner edge rather than in the flex column, so the
        library keeps the full width the person chose.
      */}
      <div
        className="documents-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the documents panel"
        aria-valuemin={MIN_DOCUMENTS_WIDTH}
        aria-valuemax={MAX_DOCUMENTS_WIDTH}
        aria-valuenow={width}
        data-resizing={resizing ? 'true' : undefined}
        title="Drag to resize"
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={endResize}
        onKeyDown={resizeByKey}
      />
      <div className="documents-head">
        <div className="documents-who">
          <h2 className="documents-title">Documents</h2>
          {space !== null && (
            <p className="documents-space" title={space.path}>
              {space.name}
            </p>
          )}
        </div>
        {space !== null && (
          <button
            type="button"
            className="button button-quiet button-small"
            title="Read the Space again"
            onClick={() => {
              void refreshList();
            }}
          >
            Refresh
          </button>
        )}
        <button
          type="button"
          className="documents-close"
          aria-label="Close documents"
          title="Close"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {space === null && editor === null && (
        /*
         * Said once, in a sentence, instead of a library over nothing: with no
         * Space loaded there is no folder to list, and an empty list would read
         * as a folder the window failed to read.
         *
         * Only while the drawer really is empty. A draft on screen means it is
         * not, and that draft outlives the Space it came from — the editor below
         * says which one it is still holding.
         */
        <p className="documents-empty">
          This install has no Space loaded, so there are no documents to show.
          Load one from the rail and its files appear here.
        </p>
      )}

      {space !== null && (
        <>
          <div className="documents-find">
            <input
              className="documents-input"
              value={query}
              spellCheck={false}
              placeholder="Filter by path…"
              aria-label="Filter documents by path"
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </div>

          <div className="documents-actions">
            <button
              type="button"
              className="button button-quiet button-small"
              aria-expanded={naming === 'new'}
              onClick={() => {
                beginNaming(naming === 'new' ? 'none' : 'new');
              }}
            >
              New file
            </button>
            {/*
              Here rather than in the composer's `+` menu. That menu is a list of
              verbs that need nothing but the conversation; this needs a name and
              a destination, and the drawer already knows both — it is the panel
              that names the Space and the file. Drawn only when there is a
              conversation with something in it to write down.
            */}
            {sessionId !== null &&
              profileId !== undefined &&
              hasConversation && (
                <button
                  type="button"
                  className="button button-quiet button-small"
                  aria-expanded={naming === 'chat'}
                  onClick={() => {
                    beginNaming(naming === 'chat' ? 'none' : 'chat');
                  }}
                >
                  Keep this chat
                </button>
              )}
          </div>

          {naming !== 'none' && (
            <form
              className="documents-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitName();
              }}
            >
              <input
                className="documents-input"
                autoFocus
                value={nameDraft}
                spellCheck={false}
                aria-label={
                  naming === 'chat'
                    ? 'File name for this chat'
                    : 'New file name'
                }
                placeholder={naming === 'chat' ? 'chat.md' : 'notes.md'}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setNaming('none');
                  }
                }}
              />
              <button
                type="submit"
                className="button button-primary button-small"
                disabled={nameDraft.trim().length === 0 || working}
              >
                {naming === 'chat' ? 'Save chat' : 'Create'}
              </button>
            </form>
          )}

          {problem !== null && (
            <p className="documents-problem" role="alert">
              {problem}
            </p>
          )}

          <ul className="documents-list" aria-busy={files === null}>
            {/*
              What the server said about the listing, above the rows it is
              about: a library that stopped at its cap and said nothing would be
              the window claiming the Space holds exactly this much.
            */}
            {listNotes.length > 0 && (
              <li className="documents-note">{listNotes.join(' ')}</li>
            )}
            {files === null && problem === null && (
              <li className="documents-note">Reading the Space…</li>
            )}
            {files !== null && files.length === 0 && (
              <li className="documents-note">
                This Space holds no files yet. New file writes the first one
                here — and anything the bot writes lands beside it.
              </li>
            )}
            {files !== null && files.length > 0 && visible.length === 0 && (
              <li className="documents-note">
                Nothing in this Space matches “{query.trim()}”.
              </li>
            )}
            {groups.map((group) => (
              <li key={group.dir} className="documents-group">
                <p className="documents-group-head">{group.label}</p>
                <ul>
                  {group.files.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        className="documents-row"
                        title={file.path}
                        data-active={
                          editor?.path === file.path &&
                          editor.spaceId === space.id
                            ? 'true'
                            : undefined
                        }
                        onClick={() => {
                          void openDocument(file.path);
                        }}
                      >
                        <span className="documents-row-name">{file.name}</span>
                        <span className="documents-row-when">
                          {formatBytes(file.bytes)} ·{' '}
                          {modifiedLabel(file.modifiedAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}

      {/*
        Only ever drawn with a file open. An editor over nothing would be a box
        that cannot be typed into, and the drawer has no room to explain one.
        Outside the Space branch on purpose: a Space can be removed from the rail
        while a draft is open, and the draft is still somebody's — with no Space
        loaded the library goes and the editor stays.
      */}
      {editor !== null && (
        <div className="documents-editor">
          <div className="documents-editor-head">
            <span className="documents-path" title={editor.path}>
              {editor.path}
            </span>
            {previewable && (
              <div className="documents-modes" role="group" aria-label="View">
                {/*
                  Edit and Preview, and not the third: this column is one narrow
                  measure, and side by side would leave roughly 180px for each
                  half — too narrow to write markdown in and too narrow to read
                  what it renders to. The preview is still the live one in the
                  sense that matters: it draws the draft, not the last saved text,
                  so it is current the moment it is switched to.
                */}
                {(['edit', 'preview'] as const).map((which) => (
                  <button
                    key={which}
                    type="button"
                    className="documents-mode"
                    aria-pressed={mode === which}
                    onClick={() => {
                      setMode(which);
                    }}
                  >
                    {which === 'edit' ? 'Edit' : 'Preview'}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              className="documents-close"
              aria-label="Close the file"
              title="Close the file"
              onClick={() => {
                void closeDocument();
              }}
            >
              ×
            </button>
          </div>

          {stateLine !== null && (
            <p
              className="documents-state"
              role={editorProblem === null ? 'status' : 'alert'}
            >
              {stateLine}
            </p>
          )}

          {/*
            Said in full when it happens, because it is the one state where the
            two halves of the drawer describe different folders: the
            conversation moved to another Space while this draft was open, and
            the file stayed where it was opened — which is where it is still
            saved, whatever the list above is now listing.
          */}
          {editor.spaceId !== space?.id && (
            <p className="documents-note">
              This file is in {editor.spaceName}.{' '}
              {space === null
                ? 'No Space is loaded now.'
                : `The list above is ${space.name}.`}
            </p>
          )}

          {conflict && (
            /*
             * The point of the feature, and the reason `docs.write` answers
             * a refusal as a value.
             *
             * The draft is kept because it is the only copy of what the
             * person wrote: the file has a newer version, but nothing on
             * disk holds their sentence, and an editor that reloaded "to be
             * safe" would delete work to resolve a question about it. The
             * choice is theirs because only they know which version is the
             * one they want — the agent's newer file may be the good one, or
             * it may be the mistake they were in the middle of correcting.
             */
            <div className="documents-conflict" role="alert">
              <p>
                This file changed while you had it open — the bot may have
                written it. Nothing was written back, and your draft is still
                here.
              </p>
              <div className="documents-conflict-actions">
                <button
                  type="button"
                  className="button button-quiet button-small"
                  title="Take the file's version and lose what you typed"
                  onClick={() => {
                    void reloadDocument();
                  }}
                >
                  Reload (discards my draft)
                </button>
                <button
                  type="button"
                  className="button button-primary button-small"
                  title="Write your draft over the file's newer version"
                  onClick={() => {
                    void overwriteDocument();
                  }}
                >
                  Overwrite with my draft
                </button>
              </div>
            </div>
          )}

          {mode === 'edit' || !previewable ? (
            <textarea
              className="documents-textarea"
              value={draft}
              spellCheck={false}
              aria-label={`Editing ${editor.path}`}
              onChange={(event) => {
                const text = event.target.value;
                setEditor((current) =>
                  current === null ? current : {...current, text},
                );
              }}
            />
          ) : (
            <div className="documents-preview">
              <Markdown text={draft} />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
