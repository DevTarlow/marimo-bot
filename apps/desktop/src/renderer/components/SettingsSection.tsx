/**
 * One card of the settings screen, folded away until it is opened.
 *
 * The page grew a card at a time — agents, identity, abilities, the companion,
 * commands, models, memory, connectors — and the eighth is the one that
 * turns it into a scroll. Folding is what puts its shape back on one screen:
 * eight headings to read, and the one you came for opened.
 *
 * `<details>` rather than a hand-rolled box, because the browser already gives
 * this a focusable control, Enter and Space, and the state a screen reader
 * wants to announce. What is *not* left to the DOM is the open state: React
 * owns it, because every switch in here re-reads the settings, and a redraw
 * that let the browser reapply the default would fold a panel somebody had just
 * opened.
 *
 * The list of open sections is passed in rather than each panel keeping its
 * own, because the file stores that list whole: a panel that wrote its own name
 * would drop every other panel's.
 */
export function SettingsSection({
  title,
  opened,
  onToggle,
  danger,
  children,
}: {
  /** The panel's name, and the key its state is stored under. */
  title: string;
  /** Every panel currently open. */
  opened: ReadonlySet<string>;
  onToggle: (title: string, expanded: boolean) => void;
  /**
   * Drawn in the warning colour, for the one card whose subject is destruction.
   *
   * A folded card hides its own warning, so the heading is what has to carry it:
   * the reset is the last heading on a screen of folded cards, and the one
   * somebody scans past should still look like the one that cannot be undone.
   */
  danger?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const expanded = opened.has(title);

  return (
    <details
      className={
        danger === true
          ? 'settings-section settings-section-danger'
          : 'settings-section'
      }
      open={expanded}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        /*
         * React writes this attribute too, and a write the browser did not get
         * from a click fires another toggle of its own. Ignoring the event that
         * agrees with what is already drawn leaves clicks as the only thing
         * that counts — otherwise one panel closing in code becomes a second
         * write of the same state.
         */
        if (next === expanded) {
          return;
        }
        onToggle(title, next);
      }}
    >
      {/*
        The heading is inside the control rather than beside it. A summary is
        what the keyboard stops on, so the words that say what the panel holds
        have to *be* it — a chevron on its own is a control with no name.
      */}
      <summary className="settings-section-head">
        <span className="settings-section-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        <h3>{title}</h3>
      </summary>
      <div className="settings-section-body">{children}</div>
    </details>
  );
}
