
/*
 * The only module that talks to Composio (D09). It reads COMPOSIO_API_KEY
 * (the project key; the token never leaves Composio). Per-provider auth
 * config ids are NOT deployment config: the project key is enough to list
 * them from the Composio API, so the server resolves toolkit slug → auth
 * config id itself and caches the result. COMPOSIO_AUTH_CONFIG_<PROVIDER>
 * survives only as a manual override for a project with several configs for
 * one toolkit. Without the API key the connect flow reports "not
 * configured" instead of failing sideways. API: POST
 * /api/v3.1/connected_accounts/link (docs.composio.dev connected-accounts
 * reference).
 */

const API_BASE = "https://backend.composio.dev/api/v3.1";
/**
 * The v3 tool-execution surface. The v3.1 base above serves connect links; the
 * proxy endpoint that carries a plain HTTP call through a connected account is
 * still on v3 (verified in src/integrations/notion/client.ts and
 * src/integrations/google-calendar/client.ts, 2026-10-18).
 */
const EXECUTE_PROXY_URL = "https://backend.composio.dev/api/v3/tools/execute/proxy";

/**
 * Methods a *read* capability may use. Anything that could change state on the
 * provider is refused here rather than trusted to a tool author: the policy
 * layer decides whether a capability is allowed at all, and this decides whether
 * it is safe to run inline. Writes go through action proposals, never this path.
 */
const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * The only method the write path accepts. Narrow on purpose: a write executor
 * that also took DELETE would make "an approved send" mean anything.
 */
const WRITE_METHOD = "POST";

export class ComposioReadOnlyViolationError extends Error {
  readonly code = "composio_read_only_violation";
  constructor(method: string) {
    super(`Composio inline execution refused a ${method} call: only reads may run inside a turn.`);
  }
}

export class ComposioWriteMethodError extends Error {
  readonly code = "composio_write_method";
  constructor(method: string) {
    super(`Composio write execution refused a ${method} call: the write path is POST-only.`);
  }
}

export class ComposioNotConfiguredError extends Error {
  readonly code = "composio_not_configured";
}

/*
 * A hosted-link request that reached Composio and failed. The status is kept
 * on the error because a 401 is a deployment problem (the stored API key is
 * invalid) with a different fix than a provider outage, and the account row
 * should say so instead of rotting into a misleading "expired".
 */
export class ComposioLinkError extends Error {
  readonly code = "composio_link_failed";
  readonly status: number;
  constructor(status: number) {
    // Keep the "failed (N)" phrasing the client test pins; the 401 tail
    // names the cause so the card's lastError says what to fix. The key
    // itself never appears in the message.
    super(
      status === 401
        ? "Composio link request failed (401): the deployment's COMPOSIO_API_KEY is invalid."
        : `Composio link request failed (${status}).`,
    );
    this.status = status;
  }
}

export function authConfigEnvName(provider: string) {
  return `COMPOSIO_AUTH_CONFIG_${provider.toUpperCase().replace(/-/g, "_")}`;
}

/*
 * Toolkit slug → provider spelling. Catalog providers use kebab-case
 * ("google-calendar"); Composio slugs are lowercase concatenated
 * ("googlecalendar"). Discovery matches on the concatenated form, so an
 * override env name keeps its own mapping via authConfigEnvName.
 */
export function composioToolkitSlug(provider: string) {
  return provider.replace(/-/g, "");
}

type DiscoveredConfigs = { at: number; bySlug: Map<string, string> };
let discoveryCache: DiscoveredConfigs | null = null;
const DISCOVERY_TTL_MS = 5 * 60_000;

async function discoverAuthConfigs(apiKey: string): Promise<DiscoveredConfigs> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache;
  }
  const response = await fetch(`${API_BASE}/auth_configs?limit=100`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new ComposioLinkError(response.status);
  }
  const body = (await response.json()) as {
    items?: Array<{ id: string; toolkit?: { slug?: string }; status?: string }>;
  };
  const bySlug = new Map<string, string>();
  for (const item of body.items ?? []) {
    const slug = item.toolkit?.slug;
    // The newest config wins for a duplicated toolkit; items arrive newest-first.
    if (slug && item.status === "ENABLED" && !bySlug.has(slug)) {
      bySlug.set(slug, item.id);
    }
  }
  discoveryCache = { at: Date.now(), bySlug };
  return discoveryCache;
}

/** Test seam: drop the cached discovery so a stubbed fetch is exercised. */
export function resetAuthConfigDiscovery() {
  discoveryCache = null;
}

/**
 * The auth config id for a provider: the manual override env var wins, then
 * the project's own configs discovered through the API. Null when the API
 * key is missing or the project has no config for the toolkit yet — callers
 * turn that into "not configured" copy rather than guessing an id.
 */
export async function resolveAuthConfigId(provider: string): Promise<string | null> {
  const override = process.env[authConfigEnvName(provider)];
  if (override) return override;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;
  try {
    const { bySlug } = await discoverAuthConfigs(apiKey);
    return bySlug.get(composioToolkitSlug(provider)) ?? null;
  } catch {
    // Discovery is a convenience over an explicitly-set API key; a transient
    // Composio outage must not turn a configured deployment into a broken
    // connect page. Fail closed to "not configured" for this call only.
    return null;
  }
}

/** True when the deployment can attempt a link for this provider at all. */
export async function isComposioConfigured(provider: string): Promise<boolean> {
  return (await resolveAuthConfigId(provider)) !== null;
}

/** Creates the hosted-auth link session. Throws ComposioNotConfiguredError when env is missing. */
export async function createHostedConnectLink(input: {
  provider: string;
  userId: string;
  callbackUrl: string;
}): Promise<{ redirectUrl: string; connectedAccountId: string; expiresAt: string }> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  const authConfigId = await resolveAuthConfigId(input.provider);
  if (!apiKey || !authConfigId) {
    throw new ComposioNotConfiguredError(
      `Composio is not configured for "${input.provider}" on this deployment yet.`,
    );
  }
  /*
   * No `alias` in this payload. Composio rejects a link whose alias is already
   * taken by ANY connected account under the same user_id (400, code 600) —
   * including accounts Polymath's database no longer knows about (a local
   * reset, or a revoked-local account that stays live on Composio's side).
   * The local alias is workspace bookkeeping only; the callback resolves by
   * state token and the account by connected_account_id, so the hosted flow
   * never needed the name.
   */
  const response = await fetch(`${API_BASE}/connected_accounts/link`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      auth_config_id: authConfigId,
      user_id: input.userId,
      callback_url: input.callbackUrl,
    }),
  });
  if (!response.ok) {
    throw new ComposioLinkError(response.status);
  }
  const body = (await response.json()) as { redirect_url: string; connected_account_id: string; expires_at: string };
  return { redirectUrl: body.redirect_url, connectedAccountId: body.connected_account_id, expiresAt: body.expires_at };
}

/** Callback-side verification: the account Composio says it connected. */
export async function getConnectedAccount(connectedAccountId: string): Promise<{
  id: string;
  status: string;
}> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    throw new ComposioNotConfiguredError("Composio is not configured on this deployment yet.");
  }
  const response = await fetch(`${API_BASE}/connected_accounts/${encodeURIComponent(connectedAccountId)}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`Composio account lookup failed (${response.status}).`);
  }
  const body = (await response.json()) as { id: string; status: string };
  return { id: body.id, status: body.status };
}

/** One provider call routed through a connected account. The token stays with Composio. */
export type ComposioCall = {
  connectedAccountId: string;
  endpoint: string;
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
};

export type ComposioCallResult =
  | { ok: true; data: unknown }
  // `status` is additive: the gateway tells a revoked credential (401) from a
  // provider outage (500), and reading it back out of `message` would break the
  // first time the wording changed.
  | { ok: false; code: "not_configured" | "read_only_violation" | "provider_error"; message: string; status?: number };

/**
 * Runs one read against a provider through Composio and returns its parsed body.
 *
 * This is the inline-execution seam for agent tools. It is deliberately narrow:
 *  - reads only. A write-shaped method throws `ComposioReadOnlyViolationError`
 *    rather than returning an error object, because reaching it is a programming
 *    error in the tool, not a condition a model should see and retry.
 *  - no retry. A read is safe to retry at the caller, but silently retrying a
 *    provider call inside a turn hides the failure from the user.
 *  - the caller has already checked the run's policy snapshot; this function
 *    cannot see a policy and must not be the only gate.
 */
/*
 * The one POST through the proxy that every read path shares. The proxy
 * answers `{ data: <provider body> }`; a bare body is accepted too, because
 * the two shipped clients had to handle both shapes. No retry anywhere here:
 * silently retrying a provider call inside a turn hides the failure from the
 * user. The write path keeps its own fetch - its timeout makes a failure
 * `ambiguous`, a deliberately different contract.
 */
async function postThroughProxy(payload: Record<string, unknown>): Promise<ComposioCallResult> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return { ok: false, code: "not_configured", message: "Composio is not configured on this deployment yet." };
  let response: Response;
  try {
    response = await fetch(EXECUTE_PROXY_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, code: "provider_error", message: "The connected service is unreachable." };
  }
  if (!response.ok) {
    return { ok: false, code: "provider_error", status: response.status, message: `The connected service returned ${response.status}.` };
  }
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (body === null) return { ok: false, code: "provider_error", message: "The connected service returned no body." };
  return { ok: true, data: "data" in body ? body.data : body };
}

export async function executeComposioRead(call: ComposioCall): Promise<ComposioCallResult> {
  if (!READ_METHODS.has(call.method)) throw new ComposioReadOnlyViolationError(call.method);
  const parameters = Object.entries(call.headers ?? {}).map(([name, value]) => ({ name, value, type: "header" }));
  for (const [name, value] of Object.entries(call.query ?? {})) {
    parameters.push({ name, value, type: "query" });
  }
  return postThroughProxy({
    connected_account_id: call.connectedAccountId,
    endpoint: call.endpoint,
    method: call.method,
    ...(call.body === undefined ? {} : { body: call.body }),
    parameters,
  });
}

/*
 * GraphQL is POST on the wire, so the read-only method guard cannot admit it.
 * This path instead refuses anything that is not a single query document, and
 * the endpoint is fixed by the caller's module, never by a model. A document
 * naming a mutation or subscription is refused before any request is built.
 */
const GRAPHQL_FORBIDDEN = /\b(mutation|subscription)\b/i;

export class ComposioGraphqlNotQueryError extends Error {
  readonly code = "composio_graphql_not_query";
  constructor() {
    super("Composio inline GraphQL refused a document that is not a plain query.");
  }
}

export async function executeComposioGraphqlRead(call: {
  connectedAccountId: string;
  endpoint: string;
  query: string;
  variables?: Record<string, unknown>;
}): Promise<ComposioCallResult> {
  if (!/^\s*query\b/.test(call.query) || GRAPHQL_FORBIDDEN.test(call.query)) throw new ComposioGraphqlNotQueryError();
  return postThroughProxy({
    connected_account_id: call.connectedAccountId,
    endpoint: call.endpoint,
    method: "POST",
    body: { query: call.query, variables: call.variables ?? {} },
    parameters: [],
  });
}

/*
 * A constant-body POST read (Notion search). Same seam discipline as the
 * GraphQL read: the provider module fixes the endpoint and the body shape,
 * caller-supplied values travel inside the body only after validation, and
 * the proxy still answers `{ data: <provider body> }`. There is no method
 * parameter - a POST read cannot become anything else from here.
 */
export async function executeComposioPostRead(call: {
  connectedAccountId: string;
  endpoint: string;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<ComposioCallResult> {
  const parameters = Object.entries(call.headers ?? {}).map(([name, value]) => ({ name, value, type: "header" }));
  return postThroughProxy({
    connected_account_id: call.connectedAccountId,
    endpoint: call.endpoint,
    method: "POST",
    body: call.body,
    parameters,
  });
}

/** A write call: the method is fixed at the type level, and guarded at runtime. */
export type ComposioWriteCall = Omit<ComposioCall, "method"> & { method: "POST" };

export type ComposioWriteResult =
  | { ok: true; data: unknown; /** The provider's own HTTP status, from the proxy's 200 envelope, when present. */ providerStatus?: number }
  // `ambiguous` is the important one: the request may have reached the provider.
  // Anything that cannot prove "not sent" belongs here, and the executor turns
  // it into UNKNOWN rather than a retry.
  | { ok: false; code: "not_configured" | "provider_error" | "ambiguous"; message: string; status?: number };

/**
 * Runs one write through Composio. Reachable only from the approved-effect
 * executor — nothing in a turn can call it, and nothing should: a model that
 * could reach this would be a model that can send mail without review.
 *
 * POST only. The read path refuses writes; this refuses everything that is not
 * a write, so neither path can quietly widen into the other.
 *
 * The timeout exists to bound the executor's request, not to make the send
 * safe: a timeout is `ambiguous`, because the provider may have accepted the
 * request before the socket died.
 */
const WRITE_TIMEOUT_MS = 30_000;

export async function executeComposioWrite(call: ComposioWriteCall): Promise<ComposioWriteResult> {
  if (call.method !== WRITE_METHOD) throw new ComposioWriteMethodError(String(call.method));
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return { ok: false, code: "not_configured", message: "Composio is not configured on this deployment yet." };
  }
  const parameters = Object.entries(call.headers ?? {}).map(([name, value]) => ({ name, value, type: "header" }));
  for (const [name, value] of Object.entries(call.query ?? {})) {
    parameters.push({ name, value, type: "query" });
  }
  let response: Response;
  try {
    response = await fetch(EXECUTE_PROXY_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      body: JSON.stringify({
        connected_account_id: call.connectedAccountId,
        endpoint: call.endpoint,
        method: call.method,
        ...(call.body === undefined ? {} : { body: call.body }),
        parameters,
      }),
    });
  } catch {
    return { ok: false, code: "ambiguous", message: "The connected service did not answer; the outcome is unknown." };
  }
  if (!response.ok) {
    const status = response.status;
    /*
     * This status is the PROXY's own, not the provider's. Composio's proxy
     * contract (docs.composio.dev /reference/v3/api-reference/tools
     * /postToolsExecuteProxy, fetched 2026-10-23) returns the provider's
     * response - including the provider's error status - inside a 200
     * envelope (`status` field). A non-200 here is the proxy's documented
     * own error (400 invalid proxy request, 401 bad project key, 403/404
     * account problems, 422 invalid account state, 429 rate limit refused,
     * 501 unsupported): every one refuses BEFORE dispatch, so the call
     * provably never reached the provider. A 5xx says nothing about whether
     * the proxy dispatched first, so it stays ambiguous.
     */
    return status >= 400 && status < 500
      ? { ok: false, code: "provider_error", status, message: `The connected service rejected the call (${status}).` }
      : { ok: false, code: "ambiguous", status, message: `The connected service returned ${status}.` };
  }
  // A 2xx whose body cannot be parsed is still a success at the provider with
  // no id we can record, which the caller cannot distinguish from a lost
  // response. Say so rather than inventing an outcome.
  const body = (await response.json().catch(() => null)) as { data?: unknown; status?: unknown } | null;
  if (body === null) {
    return { ok: false, code: "ambiguous", status: response.status, message: "The connected service returned no parseable body." };
  }
  // The envelope carries the provider's own status (`status`, required by the
  // contract) alongside the provider body (`data`). Surface it: a provider
  // 4xx arrives here as a proxy 200 and must not read as success.
  const providerStatus = typeof body.status === "number" ? body.status : undefined;
  return { ok: true, data: "data" in body ? body.data : body, providerStatus };
}
