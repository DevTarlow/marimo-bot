/**
 * The skills file, connected to the profiles that carry them.
 *
 * The agent package declares what `save_skill` needs (`SkillService` in
 * `tools/skill-tools.ts`) and this is the implementation. It lives in its own
 * module because a save is a *pair* of changes that both have to happen, and the
 * second one is the whole reason the tool exists.
 *
 * **Saving a skill and switching it on are one operation for the agent.** A file
 * written but not named in the asking bot's `enabledSkills` is invisible: it is
 * not advertised in the prompt, nothing in Settings says it exists for that bot,
 * and the model that just told the user it would remember this has remembered
 * nothing they can observe. So `saveFromAgent` writes the file first and grants
 * the name second — a skill that cannot be written must not be switched on, while
 * a skill written and not switched on is a state a person can see and fix.
 *
 * The Settings editor is the other way in, and it deliberately does *not* grant:
 * somebody looking at a list of switches is making two decisions, and silently
 * ticking a box under their cursor is the other kind of wrong. A rename is
 * different and is carried for everyone, because the grant names the skill and a
 * silent rename would leave a bot carrying a skill that no longer exists.
 *
 * It is not atomic across the two documents, and pretending otherwise would be
 * worse than saying so: `SKILL.md` and `profiles.json` are separate files with
 * separate writers, and the failure window is one write. What is left in that
 * window is a skill on disk that nothing carries — visible in Settings, and fixed
 * by ticking its box.
 */
import type {AgentProfile, SkillDraft, StoredSkill} from '@marimo/protocol';

import type {ProfileStore} from './profiles.js';
import {normaliseName} from './skills.js';
import type {SkillStore} from './skills.js';

export interface RuntimeSkillServiceOptions {
  skills: SkillStore;
  profiles: ProfileStore;
}

export class RuntimeSkillService {
  constructor(private readonly options: RuntimeSkillServiceOptions) {}

  /** Every skill on disk, for Settings. */
  async list(): Promise<StoredSkill[]> {
    return await this.options.skills.load();
  }

  /**
   * The skills one profile carries, which is the only set it may load.
   *
   * Read fresh from the profile rather than captured when a host was built: a
   * grant can change between turns, and a library holding yesterday's answer
   * would either offer a skill the user switched off or hide one they just
   * granted.
   */
  async granted(profile: AgentProfile): Promise<StoredSkill[]> {
    if (profile.enabledSkills.length === 0) {
      return [];
    }
    const wanted = new Set(profile.enabledSkills);
    return (await this.options.skills.load()).filter((skill) =>
      wanted.has(skill.name),
    );
  }

  /** The same answer from a profile id, for a tool that was built without one. */
  async grantedForProfile(profileId: string): Promise<StoredSkill[]> {
    const profile = (await this.options.profiles.profiles()).find(
      (entry) => entry.id === profileId,
    );
    return profile === undefined ? [] : await this.granted(profile);
  }

  /**
   * The agent's save: write the file, then switch it on for the bot that asked.
   *
   * `updated` is what the model repeats back, and it is the difference between
   * "I have written that down" and "I have replaced what I had" — two sentences
   * about the same file, and only one of them is true on a re-save.
   */
  async saveFromAgent(
    input: SkillDraft,
    profileId: string,
  ): Promise<{name: string; updated: boolean}> {
    const {skill, updated, renamedFrom} = await this.options.skills.save(input);

    /*
     * A rename moves the grant for every profile that had the old name, and only
     * then is the asking one granted the new name. Doing it in the other order
     * would briefly leave two names for one file.
     */
    if (renamedFrom !== undefined) {
      await this.carryRename(renamedFrom, skill.name);
    }
    await this.grant(profileId, skill.name);

    return {name: skill.name, updated};
  }

  /**
   * The editor's save: write the file, and correct grants a rename moved.
   *
   * It does not add the name to the profile being edited. The card is a list of
   * switches, and a save that also ticked one would be two decisions in one
   * click. A rename *is* carried, because the alternative is a bot that carries a
   * name nothing answers to.
   */
  async saveFromEditor(
    draft: SkillDraft,
    id?: string,
  ): Promise<{skills: StoredSkill[]; saved: StoredSkill}> {
    const {skill, renamedFrom} = await this.options.skills.save(draft, id);
    if (renamedFrom !== undefined) {
      await this.carryRename(renamedFrom, skill.name);
    }
    return {skills: await this.options.skills.load(), saved: skill};
  }

  /**
   * Removes a skill and every grant of its name.
   *
   * A grant for a name no file holds reads as on over nothing in Settings, and
   * is a name the model is told it may load when it cannot. Both are worse than
   * the write.
   */
  async remove(id: string): Promise<StoredSkill[]> {
    const before = await this.options.skills.load();
    const target = before.find((skill) => skill.id === id);
    const after = await this.options.skills.remove(id);
    if (target !== undefined) {
      await this.updateGrants((profile) =>
        profile.enabledSkills.filter((name) => name !== target.name),
      );
    }
    return after;
  }

  /** The skill a model asked for, and the names it could have asked for. */
  async load(
    profileId: string,
    rawName: string,
  ): Promise<{skill?: StoredSkill; names: string[]}> {
    const granted = await this.grantedForProfile(profileId);
    const wanted = normaliseName(rawName);
    const skill = granted.find((entry) => entry.name === wanted);
    return {
      ...(skill === undefined ? {} : {skill}),
      names: granted.map((entry) => entry.name),
    };
  }

  private async grant(profileId: string, name: string): Promise<void> {
    const profile = (await this.options.profiles.profiles()).find(
      (entry) => entry.id === profileId,
    );
    if (profile === undefined || profile.enabledSkills.includes(name)) {
      return;
    }
    await this.options.profiles.update(profileId, {
      enabledSkills: [...profile.enabledSkills, name],
    });
  }

  /** Moves every grant of `from` onto `to`, and drops the duplicate. */
  private async carryRename(from: string, to: string): Promise<void> {
    await this.updateGrants((profile) => {
      if (!profile.enabledSkills.includes(from)) {
        return undefined;
      }
      return [
        ...new Set(
          profile.enabledSkills.map((name) => (name === from ? to : name)),
        ),
      ];
    });
  }

  private async updateGrants(
    next: (profile: AgentProfile) => string[] | undefined,
  ): Promise<void> {
    for (const profile of await this.options.profiles.profiles()) {
      const enabledSkills = next(profile);
      if (enabledSkills === undefined) {
        continue;
      }
      await this.options.profiles.update(profile.id, {enabledSkills});
    }
  }
}
