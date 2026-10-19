/**
 * The ADK author name for an agent id, and the id behind a name.
 *
 * These lived on `AgentHost` only because that class was the one place ADK names
 * were minted. The transcript reader still needs them, and it outlives the host.
 */
export function agentNameFor(agentId: string): string {
  return `a_${agentId.replaceAll('_', '_u').replaceAll('-', '_d')}`;
}

/** The id behind a name this build wrote, or `undefined` for anything else. */
export function agentIdFor(author: string | undefined): string | undefined {
  if (author === undefined || !author.startsWith('a_')) {
    return undefined;
  }
  return author.slice(2).replaceAll('_d', '-').replaceAll('_u', '_');
}
