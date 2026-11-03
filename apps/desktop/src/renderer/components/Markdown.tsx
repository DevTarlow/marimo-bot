/**
 * Drawing a parsed answer.
 *
 * Every text node here is a React text node, so it is escaped by the framework
 * and there is no `dangerouslySetInnerHTML` in the app. That is the whole reason
 * the parser in `markdown.ts` produces data instead of an HTML string: the
 * safety does not depend on a sanitiser being configured correctly, because
 * there is nothing to sanitise.
 */
import {createElement} from 'react';

import {copyLabel, useCopy} from '../clipboard.js';
import {parseInline, parseMarkdown, renderInline} from '../markdown.js';
import type {Block} from '../markdown.js';

/** A copy button that says what happened, then stops saying it. */
function Copy({text, what}: {text: string; what: string}): React.JSX.Element {
  const {state, copy} = useCopy();

  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${what}`}
      onClick={() => {
        copy(text);
      }}
    >
      {copyLabel(state)}
    </button>
  );
}

/** One code block, with the language and a way to take it away. */
function Code({language, text}: {language: string; text: string}): React.JSX.Element {
  return (
    <div className="md-pre">
      <div className="md-pre-head">
        <span className="md-pre-lang">{language}</span>
        <Copy text={text} what="code" />
      </div>
      {/*
        Rendered as text inside `pre`, so it keeps its own whitespace and no
        construct inside it is interpreted. A code block is the one place an
        answer's content is most likely to contain something that looks like
        markup, and the least likely to mean it.
      */}
      <pre className="md-pre-body">{text}</pre>
    </div>
  );
}

function Lines({text}: {text: string}): React.JSX.Element {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, position) => (
        <span key={position}>
          {renderInline(parseInline(line))}
          {position < lines.length - 1 && <br />}
        </span>
      ))}
    </>
  );
}

function BlockView({block}: {block: Block}): React.JSX.Element {
  switch (block.kind) {
    case 'heading':
      // `h3` upwards regardless of the level written. An answer is already
      // inside the page's own hierarchy, and an `h1` in a reply would outrank
      // the conversation's title.
      return createHeading(block.level, block.text);
    case 'code':
      return <Code language={block.language} text={block.text} />;
    case 'list': {
      const items = block.items.map((item, position) => (
        <li key={position}>
          <Lines text={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="md-list" start={block.start}>
          {items}
        </ol>
      ) : (
        <ul className="md-list">{items}</ul>
      );
    }
    case 'quote':
      return (
        <blockquote className="md-quote">
          <Lines text={block.text} />
        </blockquote>
      );
    case 'rule':
      return <hr className="md-rule" />;
    default:
      return (
        <p className="md-p">
          <Lines text={block.text} />
        </p>
      );
  }
}

/**
 * The heading, shifted down the page's own hierarchy.
 *
 * An answer is already inside the conversation's structure, and a `#` written by
 * the model would otherwise outrank the window's own title. So the smallest
 * heading an answer can produce is an `h3`.
 */
function createHeading(level: number, text: string): React.JSX.Element {
  const tag = `h${String(Math.min(Math.max(level + 2, 3), 6))}`;
  return createElement(
    tag,
    {className: 'md-h'},
    renderInline(parseInline(text)),
  );
}

export function Markdown({text}: {text: string}): React.JSX.Element {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((block, position) => (
        <BlockView key={position} block={block} />
      ))}
    </div>
  );
}

export {Copy};
