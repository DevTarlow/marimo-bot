/**
 * The files a message names, drawn where the message is.
 *
 * A user's message is one string, and the files on it are paths in that string
 * — the transcript holds no second copy to draw from. So a picture is fetched
 * through `marimo-asset://` from the conversation's own Space: the main process
 * resolves the conversation's folder and refuses anything outside it, with the
 * same guard the agent's file tools use.
 *
 * The thumbnail is deliberately smaller than the message column and capped in
 * both directions: a 4000-pixel photograph drawn at its own size turns one
 * message into a screenful. The whole of it is the button that opens the larger
 * view, so the picture is not a link somebody has to guess at.
 *
 * A picture that will not load falls back to the file's name rather than an
 * empty frame. The file can have been moved or deleted since the message was
 * sent, and a chip naming it is the useful answer to that.
 */
import {useEffect, useRef, useState} from 'react';

import {isImagePath, spaceImageUrl} from '@marimo/protocol';
import type {AttachedFile} from '@marimo/protocol';

/** A picture open in the larger view. */
export interface PreviewTarget {
  /** The URL to draw, already absolute for the scheme. */
  source: string;
  /** The file's name, as the caption and the dialog's label. */
  name: string;
}

/** The Space a transcript's pictures come from. */
export interface MessageSpace {
  profileId: string;
  sessionId: string;
}

export function MessageFiles({
  files,
  space,
  onPreview,
}: {
  files: readonly AttachedFile[];
  /**
   * The conversation the message belongs to, or null before one is open.
   *
   * Null draws the files' names: there is no URL to ask for without a
   * conversation, and a picture that is certain to fail is worse than its name.
   */
  space: MessageSpace | null;
  onPreview: (target: PreviewTarget) => void;
}): React.JSX.Element | null {
  if (files.length === 0) {
    return null;
  }
  return (
    <div className="message-files">
      {files.map((file, index) =>
        space !== null && isImagePath(file.path) ? (
          <AttachedImage
            key={`${String(index)}:${file.path}`}
            file={file}
            space={space}
            onPreview={onPreview}
          />
        ) : (
          <FileChip key={`${String(index)}:${file.path}`} file={file} />
        ),
      )}
    </div>
  );
}

/** One picture, small enough to sit in a message and a button to see it larger. */
function AttachedImage({
  file,
  space,
  onPreview,
}: {
  file: AttachedFile;
  space: MessageSpace;
  onPreview: (target: PreviewTarget) => void;
}): React.JSX.Element {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return <FileChip file={file} />;
  }
  const source = spaceImageUrl(space.profileId, space.sessionId, file.path);
  return (
    <button
      type="button"
      className="message-image"
      title={`${file.path} — click to see it larger`}
      aria-label={`See ${file.name} larger`}
      onClick={() => {
        onPreview({source, name: file.name});
      }}
    >
      <img
        src={source}
        alt={file.name}
        loading="lazy"
        onError={() => {
          setBroken(true);
        }}
      />
    </button>
  );
}

/** A file the chat cannot draw, named rather than dropped. */
function FileChip({file}: {file: AttachedFile}): React.JSX.Element {
  return (
    <span className="message-file" title={file.path}>
      {file.name}
    </span>
  );
}

/**
 * One attached picture, as large as the window allows.
 *
 * A dialog because that is what it is: the transcript is still there behind it
 * and goes back to being the only thing on screen when it closes. It closes on
 * Escape, on the button, and on a click in the dim area — the three things
 * somebody tries — and focus returns to the picture they opened, so a keyboard
 * user is where they were rather than at the top of the page.
 */
export function ImageViewer({
  target,
  onClose,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (target === null) {
      return;
    }
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    close.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [target, onClose]);

  if (target === null) {
    return null;
  }

  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`${target.name}, larger view`}
      onClick={(event) => {
        // A click on the dim area closes it; the picture and its caption do not.
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onKeyDown={(event) => {
        /*
         * The close button is the only thing inside that takes focus, so Tab
         * would otherwise walk into the transcript behind the dialog. Keeping
         * focus here is the whole of the trap this view needs.
         */
        if (event.key === 'Tab') {
          event.preventDefault();
          close.current?.focus();
        }
      }}
    >
      <button
        ref={close}
        type="button"
        className="image-viewer-close"
        aria-label="Close the larger view"
        onClick={onClose}
      >
        ×
      </button>
      <figure className="image-viewer-figure">
        <img
          className="image-viewer-image"
          src={target.source}
          alt={target.name}
        />
        <figcaption className="image-viewer-name">{target.name}</figcaption>
      </figure>
    </div>
  );
}
