/*
 * The frozen policy snapshot is the authorization boundary for a run, and an
 * allowlist that fails open is not a boundary. `allowedTools` comes from the
 * profile's jsonb (default `[]`), so anything that is not a string array — or
 * an array that does not name this capability — is a denial.
 *
 * Pure on purpose: no database, no eve import, so the acceptance suite can
 * assert the escalation rule without a running session.
 */
export function toolAllowed(snapshot: unknown, capability: string): boolean {
  const allowed = (snapshot as { allowedTools?: unknown } | null | undefined)?.allowedTools;
  if (!Array.isArray(allowed)) return false;
  return allowed.includes(capability);
}
