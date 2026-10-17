/**
 * Where the setup flow can go, as arithmetic rather than as a handler in each
 * screen.
 *
 * The flow spent its first version with one dead end: once a bot had been made,
 * the bot step offered "Never mind" and nothing else, so the Space it came from
 * was only reachable by finishing the wizard. Every step now has a Back, and the
 * target is decided here — one function, one test, no screen that has to
 * remember what came before it.
 *
 * Labels rather than "step 2 of 5": what is being decided is the useful half,
 * and a count is only how much is left.
 */
export const STEPS = [
  {id: 'provider', label: 'Model'},
  {id: 'space', label: 'Space'},
  {id: 'bot', label: 'Your first bot'},
  {id: 'persona', label: 'Make it yours'},
  {id: 'more', label: 'More bots'},
] as const;

export type StepId = (typeof STEPS)[number]['id'];
export type SetupScreen = 'welcome' | StepId;

export interface SetupBackRead {
  screen: SetupScreen;
  /** Whether the step after the brief has a real profile to edit. */
  hasMadeBot: boolean;
}

/**
 * The screen Back goes to, or `null` where there is nothing behind it.
 *
 * Welcome is the flow's first screen, so it answers `null` and draws no Back.
 * `persona` always returns to the bot list rather than to the form that made the
 * bot: the profile exists by then, and a form would make a second one.
 */
export function backTargetFor({
  screen,
  hasMadeBot,
}: SetupBackRead): SetupScreen | null {
  switch (screen) {
    case 'welcome':
      return null;
    case 'provider':
      return 'welcome';
    case 'space':
      return 'provider';
    case 'bot':
      return 'space';
    case 'persona':
      return 'bot';
    case 'more':
      return hasMadeBot ? 'persona' : 'bot';
  }
}
