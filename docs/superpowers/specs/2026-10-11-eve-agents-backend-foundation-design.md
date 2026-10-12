# Eve Agents Backend Foundation — Design

**Status:** Approved (conversational design, 2026-10-11)
**Parent:** [ASH-112](https://linear.app/ashwinr/issue/ASH-112) — bounded multi-agent architecture
**Supersedes:** the "Eve is unknown" discovery blocker in `docs/axiom-nextjs-neon-plan.md`

## What Eve is

Eve is Vercel's open framework for building agents (github.com/vercel/eve, npm `eve`,
Apache-2.0, beta). Facts that shape this design, verified against eve.dev today:

- **Agents are filesystem directories.** `agent/instructions.md` (system prompt),
  `agent/agent.ts` (model config), `agent/tools/*.ts` (typed tools with Zod schemas),
  `agent/subagents/<id>/` (specialists with their own tools, sandbox, and instructions),
  `agent/skills/` (procedures loaded on demand).
- **Durable sessions.** Every session is one durable workflow (Vercel Workflow on
  Vercel, local world in dev). Work nests as session → turn → step; steps checkpoint;
  a crashed process resumes from the last completed step. Completed steps never re-run.
- **HITL is built into tools.** `approval: always() | auto() | never() | policy` parks
  the run durably at `session.waiting` for a person. Policies receive session auth and
  can deny, auto-approve, or require user approval per call.
- **Subagents.** Root agent delegates via the built-in `agent` tool or declared
  subagents under `agent/subagents/` with their own tool surfaces. Delegation transfers
  data through the message input only; children don't see parent history.
- **Mounts into an existing Next.js app** via `withEve()` (eve@0.77.0, verified in
  `dist/src/public/next/index.d.ts`): a **next.config.ts wrapper**, not a runtime
  export. It proxies eve protocol endpoints to an eve service — `eve dev --no-ui`
  locally, Build Output service routes on Vercel prod — and named agents mount at
  **`/eve/<name>/v1/*`**. Eve requires Node 24+.
- **Evals.** `evaluate` (AI SDK evaluation API) for typed questions; tool-approval
  classifiers (`auto()` with custom instructions/criteria) for policy behavior.

## Decision

**Eve-native, Neon-mirrored.** Eve runs the durable conversation loop inside Axiom's
Next.js app. Axiom's Neon tables stay the system of record for the UI: run timelines,
tool calls, spend, approvals, and memory are mirrored from eve's event stream into
`agent_runs`, `run_events`, `tool_calls`, `agent_questions`, and `memory_items`. No
duplicate task/artifact/approval universes. Axiom's `AgentEngine` contract is the only
seam domain code sees; domain code never imports `eve` directly. The seam is real at the engine boundary;
tools, agents, and evals are eve-file-authored, so the framework choice is a
**strategic lock to eve** (a beta) owned by this spec — revisit if eve stalls.

Rejected: `@workflow/world-postgres` for session state (protocol lock against eve's
vendored `@workflow/*` line for no gain — Vercel's dashboard covers loop state), and a
long-running sidecar eve service process (violates the consolidation decision). Note:
`withEve()` itself starts a local `eve dev` service in development — that is the
framework's own dev tooling, not an Axiom-managed sidecar. Event bridge lives in
`src/domains/agents/` (D1, decided 2026-10-11): one file does not justify moving
`src/workflows/` (the empty directory from the plan layout, already present); non-agent
durable workflow definitions land there when they arrive.

## Architecture

```text
Browser → Next.js app
  ├─ App Router UI: Reviews, Activity, Alfred run timeline (RSC, reads Neon)
  ├─ /eve/<name>/v1/*  ← withEve() proxy: Alfred root + research/studio/ops subagents
  ├─ EveAgentEngine (starts/signals sessions; wraps eve; the one eve import point)
  ├─ Event bridge in src/domains/agents/event-bridge.ts (eve hooks → run tables)
  ├─ Domain modules (work, capture, crm, agents, spending, actions)
  └─ Neon Postgres + pgvector (system of record)
```

One run = one addressed eve session. Axiom generates the delegation session id and
keeps it in `agent_runs`; the event bridge keeps the mirror current.

## Work order

### Phase 0 — Spike (gates Phase B)

0. **Spike: eve hello-world inside this app** — install `eve@latest`, `ai`, `zod`;
   declare `engines.node >=24`; wrap `next.config.ts` with `withEve()`; mount one
   hello-world agent reading a stub domain query; run `eve dev --no-ui`; get one real
   event through the hook pipeline into `run_events`; confirm the Clerk auth extension
   point (custom policy resolving `AuthContext`, frozen snapshot per session). Output:
   verified `withEve()`/hook/auth API shapes or the plan is revised before Phase B.
   Spike code is throwaway; the verified API shapes are the deliverable. (D2,
   decided 2026-10-11.)

### Phase A — Auth and Clerk (built first, protects everything)

1. **`src/lib/auth.ts`** — `getAuthContext(): Promise<AuthContext>` where
   `AuthContext = { userId, workspaceId, role }`:
   - Clerk `auth()` → `clerkUserId` → upsert `users` row (first sign-in creates it).
   - Resolve active `memberships`. Single workspace per user in v1: first active
     membership, else auto-provision a personal workspace + owner membership.
   - Wrapped in React `cache()` so parallel server components share one resolution;
     one Neon round trip per request.
   - `getAuthContext` resolves identity through domain-owned queries; the Clerk→
     user→membership resolution lives in `src/domains/identity/` and is called
     from `lib/auth.ts`.
2. **Server Action guard** — `withAuth(fn)` in `src/lib/auth.ts`. Every server action
   begins `withAuth(async (auth, input) => ...)`. Unauthenticated → typed
   `UnauthorizedError` → problem+json. One line per action; cannot be forgotten.
3. **Route Handler guard** — `requireAuthContext(request)` for `/api/v1/**`: 401
   problem+json with stable code when no Clerk session. `/api/webhooks/**` exempt
   (HMAC signature is their auth, per the security contract).
4. **Eve mount auth** — the `withEve()` channel authentication policy resolves the
   Clerk session; delegated work carries the frozen `AuthContext` snapshot taken at
   session start. Live credentials never cross the boundary.
5. **Workspace scoping** — every domain query filters `workspace_id = auth.workspaceId`.
   No client ever supplies an owner id.

### Phase B — Agent engine and runtime

6. **`src/domains/agents/engine.ts`** — the `AgentEngine` contract from the plan:
   `start(input): {runId}`, `signal(runId, signal)`, `cancel(runId, actor)`,
   `resume(runId)`. First implementation `EveAgentEngine`, backed by eve sessions.
   Run row created before the session starts; policy snapshot (profile, model, tools,
   budget, auth) frozen at start.
7. **Event bridge (`src/domains/agents/event-bridge.ts`)** — eve instrumentation maps
   session/step/tool events into `run_events` (monotonic per-run sequence, the SSE
   cursor), redacted `tool_calls`, `agent_questions` on HITL questions, and state
   transitions on `agent_runs`. Also mirrors session messages into `threads`/`messages`
   with `runId` populated (D4, decided 2026-10-11) — the Alfred chat UI reads these.
   **Idempotency (D3, decided 2026-10-11):** sequence numbers are assigned in one Neon
   transaction keyed on the `(runId, sequence)` conflict target, so workflow retries
   and resumed steps that re-fire hooks dedupe instead of double-writing. Axiom run
   timeline reload reconstructs from these rows.
8. **Spending commands (`src/domains/spending/`)** — reserve before session start
   against the frozen budget (`spending_reservations`), settle on terminal event,
   release on cancel. **Settlement (D3, decided 2026-10-11):** token usage arrives in
   usage events mid-run; the bridge accumulates per-run usage and the terminal event
   closes the reservation with the accumulated amount. **Concurrency (D3):** the
   ceiling claim serializes via a Postgres advisory lock per workspace taken before
   the reservation insert, so two concurrent `start()` calls cannot both spend the
   last dollar. Release on cancel happens before the lock is held across any wait —
   reserve/settle are short transactions.
9. **Tool layer (`agent/tools/`)** — domain read tools call Axiom queries with the run's
   frozen `AuthContext`. Direct external writes never exist: tools either gate through
   eve approval (`always()`/`auto()` with Axiom policy text) or append a proposal to
   `action_proposals` for Reviews and the later ActionExecutor (A09).

### Phase C — Evals

10. **Policy evals (Vitest, real Neon)** — the ASH-112 acceptance tests: replay
    (re-run proposal → no duplicate effect), tenancy/source leakage (cross-workspace
    read denied), delegated escalation (child grant cannot exceed parent's approved
    intent and source scope), stale workers (session handoff with pending work fails
    over safely), revocation (killed session stops at the next boundary), concurrent
    budget and approval races (two runs cannot both spend the last dollar; approving
    one of several pending prompts does not authorize the others).
11. **Routing/classifier evals (eve harness)** — `evaluate()` for model routing
    choices; `auto()` with Axiom policy text as the approval classifier. Evals start
    with the first policy implementation, per the acceptance criteria.

## Schema

No new tables required for this foundation. Phase B fills
`spending_reservations`/`spend_settlements` commands, and the profile-seeding
(upserting `agent/instructions.md` into `agent_profiles`) reuses existing columns.
Profile revisions (A02) and handoffs (A07) extend `agent_profiles`/`agent_runs` in a
later migration when the first specialist profile lands — spine says: schema shaped for
many, shipped for one.

## Agent profiles (v1 set)

- **Alfred** (root): routes and converses; subjects = threads; tools = domain reads,
  delegation only.
- **research**: source investigation via Firecrawl, bounded by the parent's approved
  intent and source scope; produces cited evidence.
- **studio**: drafts artifacts/patches for review; no external access.
- **ops**: prepares external action proposals; never executes; executor work belongs
  to A09's deterministic executor, not to the profile.

Handoffs between profiles stay bounded: a child's grants never expand the approved
user intent (A07's server-issued delegation authority, built when the first handoff
journey lands).

## Testing

- **Unit (Vitest)**: auth resolution (unauthenticated, no-membership,
  auto-provision), engine contract (start/signal/cancel/resume state transitions),
  event-bridge mapping (event → row shape, sequence monotonicity, redaction).
- **Integration (real Neon)**: the ASH-112 acceptance tenancy/replay/escalation/
  budget-race tests above; plus bridge idempotency under a resumed step's re-fired
  hooks (duplicate `(runId, sequence)` insert is a no-op) and settlement accumulating
  from mid-run usage events.
- **E2E (Playwright)** adjusts when the Alfred chat UI lands; this foundation is
  backend-only and covered by the layers above.

## Out of scope (later issues)

A02 profile revisions/compile ceilings, A03 context manifests, A07 handoffs, A09
ActionExecutor, A22 run UI. The foundation creates the seams for each; none are built
here. Deprecated: nothing in the current schema is retired by this design.

## Scope record (eng review, 2026-10-11)

feature answers: no cuts proposed, feature list retained; structure: Smaller arrangement (D1, event bridge in src/domains/agents/); outside review (native Claude fallback; Codex unavailable, `AUTH_FAILED`): 8 findings resolved as — D2 add Phase 0 spike (gates Phase B); D3 apply bridge idempotency (transactional sequence claim), settlement accounting (usage events accumulate, terminal closes), budget serialization (per-workspace advisory lock); D4 bridge mirrors session messages into `threads`/`messages`; D5 swap claim reframed as a strategic engine-boundary lock (tools/agents/evals are eve-file-authored); factual corrections: `withEve()` is a next.config wrapper (verified at eve@0.77.0 `dist/src/public/next/index.d.ts:125`), mount path `/eve/<name>/v1/*`, `src/workflows/` already exists empty; accepted scope: spec updated in place (D1 edits above); pending remedies: none.

## Verified eve API shapes (spike)

Recorded by the Phase 0 spike (T1) against the **installed** `eve@0.76.3` and
`ai@7.0.137` on Node v26.10.0, verified in this repo on 2026-10-12. Verbatim from
`node_modules/eve/dist/`. Tasks T5–T8 read this section, not the plan's sketches:
where a sketch disagrees with these types, **these types win**.

The spike code itself is throwaway and lives in `eve/alfred/` — it is deleted when
the real `eve/alfred/` lands in Task 5.

### withEve import path and options shape

Import path is `eve/next` and the export is **named**, not default:

```ts
import { withEve } from "eve/next"; // NOT `import withEve from "eve/next"`
```

The plan's Step 2 sketch showed a default import; the installed package exports
`withEve` and `EVE_NEXT_SERVICE_PREFIX` as named exports
(`dist/src/public/next/index.d.ts`). Signature:

```ts
function withEve<TConfig extends EveNextConfig>(
  configOrFunction: EveNextConfigInput<TConfig>,
  options?: WithEveOptions,
): EveNextConfigFunction<TConfig>;
```

`WithEveOptions` — every field optional:

| Field | Type | Default | Notes |
|---|---|---|---|
| `eveRoot` | `string` | Next.js app root | Path to the eve root, resolved relative to `process.cwd()`. Cannot be combined with `agents`. |
| `agents` | `Record<string, string \| WithEveAgentOptions>` | discovered | Named agents mounted at `/eve/<name>/v1/*`. |
| `eveBuildCommand` | `string` | generated | Default build command for agents without their own. |
| `servicePrefix` | `string` | `"/_eve_internal/eve"` | Private production route namespace. |
| `devServerTimeoutMs` | `number` | `180000` | Dev-server start timeout. |

`WithEveAgentOptions` is `{ root: string; buildCommand?: string; servicePrefix?: string }`;
a string value is shorthand for `{ root }`.

### Project-root discovery (spike gap, blocking)

`withEve` resolves each agent root with `findEveProjectContext`, which calls
`findEveProjectRoot`, which **walks up from the agent root to the nearest
`package.json` declaring an `eve` dependency** and treats that directory as the
eve project root (`dist/src/internal/eve-project-root.js`). Consequences, both
hit during the spike:

1. `eve/alfred/` with no `package.json` walks up to the Axiom repo root. Axiom's
   repo root has an `agents/` directory (the agent-facing context docs), which
   eve reads as an **eve workspace**. It contains zero members, so every eve
   command fails with:
   `This command requires a specific agent. Pass --agent <name>. Available agents: .`
   and `withEve` dies with
   `eve server process exited before printing its server URL (code 1, signal null)`.
2. Fix, and the shape the real Task 5 layout must adopt: give the agent root its
   own `package.json` declaring `eve`, making it a **standalone** project root.
   `eve/alfred/package.json` is currently
   `{"name":"alfred","private":true,"dependencies":{"eve":"^0.76.3"}}`; it is a
   discovery marker only, not a pnpm workspace member (no entry in
   `pnpm-workspace.yaml`, no lockfile impact).

Alternative when the agent must stay inside an `agents/` workspace: name the
workspace so it does not collide with Axiom's `agents/` docs directory, or use
`eveRoot` to point at a root that is unambiguous. Task 5 must pick one
deliberately; the collision is silent otherwise.

### Mount path actually served

`agents: { alfred: "./eve/alfred" }` produced a mount at **`/eve/alfred/v1/*`**,
matching the plan. Verified against the running dev server:

```
$ curl -i http://localhost:3000/eve/alfred/v1/health
HTTP/1.1 200 OK
content-type: application/json

{"ok":true,"status":"ready","workflowId":"workflow//eve//workflowEntry"}
```

Route constants (`dist/src/protocol/routes.js`): `EVE_ROUTE_PREFIX = "/eve/v1"`,
`EVE_HEALTH_ROUTE_PATH = "${EVE_ROUTE_PREFIX}/health"`,
`EVE_INFO_ROUTE_PATH = "${EVE_ROUTE_PREFIX}/info"`,
`EVE_SESSION_ROUTE_PATH = "${EVE_ROUTE_PREFIX}/session"`. The Next.js rewrite is
`/eve/<name>/v1/:path+` → `${servicePrefix}/eve/v1/:path+`, installed in
`beforeFiles`. `GET .../v1/info` returns the full resolved agent manifest — tools,
hooks, channels, model, sandbox provider, subagents, shadowed defaults.

`eve dev` behaviour: `withEve` spawns `eve dev --no-ui --port 0` for each agent
and detects the URL from stdout (`[eve:dev:alfred] server listening at
http://127.0.0.1:57599/`). Ports are ephemeral and chosen by the OS; `pnpm dev`
(next, 3000) and the eve process never contend. `eve dev` **boots cleanly on Node
26.10.0**; the only Node-related constraint met is `engines.node >= 24`.

### Hook API surface

Import from `eve/hooks`. Hooks are authored at `agent/hooks/<slug>.ts`; the slug
is the path-relative basename, nested dirs give `auth/load-profile`.

```ts
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "session.started"(event, ctx) { /* ... */ },
    async "turn.completed"(event, ctx) { /* ... */ },
  },
});
```

```ts
function defineHook<const T extends HookDefinition>(
  definition: ExactDefinition<T, HookDefinition>,
): HookDefinition<DefinedHookEventKeys<T>>;

interface HookDefinition<TKey extends HookEventKey = HookEventKey> {
  readonly events?: StreamEventHooks<TKey>;
}
type StreamEventHook<TEvent> = (event: TEvent, ctx: HookContext) => void | Promise<void>;
```

`HookEventMap` has 34 keys. The ones T5–T8 need: `session.started`,
`session.completed`, `session.failed`, `session.waiting`, `turn.started`,
`turn.completed`, `turn.failed`, `turn.waiting`, `turn.cancelled`,
`step.started`, `step.completed`, `step.failed`, `message.received`,
`message.appended`, `message.completed`, `action.partial`, `action.result`,
`actions.requested`, `approval.candidate`, `approval.settled`,
`authorization.required`, `authorization.completed`, `input.requested`,
`input.resolved`, `task.started`, `task.settled`, `result.completed`,
`context.cleared`, `compaction.requested`, `compaction.completed`,
`reasoning.appended`, `reasoning.completed`, `agent.started`, plus `"*"` which
matches every event and runs **after** the typed handler.

`HookContext extends SessionContext`:

```ts
interface HookContext extends SessionContext {
  readonly agent: { readonly name: string; readonly nodeId?: string };
  readonly channel: { readonly kind?: string; readonly continuationToken?: string };
  cancel(): void;
}
```

Handlers are **observe-only** — they cannot inject model context. To contribute
runtime model messages use `defineDynamic` + `defineInstructions` under
`agent/instructions/`. Signatures are side-effect-only: this is the write seam
for the event bridge, not a way to steer the model.

**Verified live**, not just read from types. The spike hook fired three times with
real data:

```
spike hook: session.started {
  type: 'session.started',
  sessionId: 'wrun_01M4QE5THS9Y2TC8YD7RH8GFRK',
  agent: 'alfred',
  channelKind: 'http',
  principalType: 'user',
  principalId: 'user_2abcClerk'
}
```

`turn.completed` did not fire because the model call failed (see gaps); the
handler is registered and appears in `/eve/alfred/v1/info` under
`hooks[0].eventNames`, so the registration path is proven.

### Approval API

Two exports, both needed by T5:

```ts
import { never, once, always, auto } from "eve/tools/approval";
import type { Approval, ApprovalPolicy, ApprovalStatus, ApprovalContext } from "eve/tools/approval";
```

```ts
function never<TInput = unknown>(): ApprovalPolicy<TInput>;   // default when `approval` omitted
function once<TInput = unknown>(): ApprovalPolicy<TInput>;    // approve once per session
function always<TInput = unknown>(): ApprovalPolicy<TInput>;  // approve every call
function auto<TInput = unknown>(options?: AutoApprovalOptions): ApprovalPolicy<TInput>;
```

`auto()` is the only one that costs money: it calls an AI SDK decision model
(default `typesafe-ai/jev`) and returns `"user-approval"` when the model reports
caution, fails, or is unavailable. `AutoApprovalOptions` is
`{ model?: Experimental_DecisionModel; instructions?: string; criteria?: { clear?: string; caution?: string } }`.

The policy function shape is the real extension point — T5's Axiom risk table
becomes one of these rather than any of the helpers:

```ts
type ApprovalPolicy<TInput = Record<string, unknown>> =
  (ctx: ApprovalContext<TInput>) => ApprovalStatus | Promise<ApprovalStatus>;

interface ApprovalContext<TInput> extends SessionContext {
  readonly abortSignal: AbortSignal;
  readonly approvedTools: ReadonlySet<string>;
  readonly callId: string;
  readonly toolInput?: TInput extends object ? Readonly<TInput> : TInput;
  readonly toolName: string;
}

type ApprovalStatus =
  | undefined | boolean
  | "not-applicable" | "approved" | "denied" | "user-approval"
  | ({ readonly type: "not-applicable"; readonly reason?: never })
  | ({ readonly type: "approved"; readonly reason?: string })
  | ({ readonly type: "denied"; readonly reason?: string })
  | ({ readonly type: "user-approval"; readonly reason?: never });
```

`toolInput` can be `undefined` even when typed — guard the access. Booleans are
still accepted (`true` → `"user-approval"`, `false` → `"not-applicable"`) for
compat, and boolean promises too.

Authoring shape on a tool, and the responder-authorization seam T5 needs to
restrict who may approve:

```ts
export default defineTool({
  description: "…",
  inputSchema: z.object({ /* … */ }),
  approval: always(),                                  // or a policy fn
  async execute(input) { /* … */ },
});

// or, with a response policy:
approval: {
  request: always(),
  response: ({ request, response, session, auth }) => {
    const canApprove = /* … */;
    return canApprove ? { status: "allowed" } : { status: "rejected", reason: "…" };
  },
}
```

`ApprovalRequest.principal` is captured when the approval is requested and stays
fixed while other people continue the session; `ApprovalResponse.principal` is
whoever submitted the decision. Comparing the two is how "only the requester can
approve" is expressed. `{ status: "rejected" }` leaves the request **pending** so
another eligible responder can settle it; `{ status: "allowed" }` decides it.
Default response authorization: only the person whose turn requested the call.

**Verified live**: the spike tool `spike_probe.ts` with `approval: always()`
compiled and is reported by `/eve/alfred/v1/info` as
`"name":"spike_probe","requiresApproval":true`, alongside the framework default
tools which all report `"requiresApproval":false`.

### Session auth API

**Yes — a custom policy can resolve an arbitrary incoming credential.** This was
the spike's most important open question and the answer is a clean yes.
`vercelOidc()` is a convenience, not a requirement; a plain `AuthFn` is
first-class.

Import from `eve/channels/auth`, wired on the HTTP channel at
`agent/channels/eve.ts`:

```ts
import { eveChannel } from "eve/channels/eve";
import { type AuthFn, localDev } from "eve/channels/auth";

export default eveChannel({
  auth: [myClerkAuthFn, localDev()],   // single AuthFn or an ordered array
});
```

```ts
type AuthFn<TEvent = Request> =
  (event: TEvent) => AuthResult | null | undefined | Promise<AuthResult | null | undefined>;

interface AuthResult extends SessionAuthContext {
  readonly allowToolStubs?: boolean;
}

interface SessionAuthContext {
  readonly attributes: Readonly<Record<string, string | readonly string[]>>;
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly subject?: string;
}
```

Ordered-walk semantics: the first entry returning a `SessionAuthContext` accepts
and stops the walk; `null`/`undefined` skips to the next entry; **throwing**
rejects with a specific status (`UnauthenticatedError` → 401,
`ForbiddenError` → 403). If every entry skips, the request gets a 401 whose
`WWW-Authenticate` advertises the declared schemes. Routes covered: `POST
/eve/v1/session`, `POST /eve/v1/session/:sessionId`, the
cancel/compact/clear/reset controls, and `GET /eve/v1/session/:sessionId/stream`.
**`GET /eve/v1/health` is public and skips the walk entirely**, so a liveness
probe needs no credential. Auth fails closed — anonymous access requires an
explicit `none()`.

Other shipped helpers on `eve/channels/auth`: `none()`, `localDev()`,
`vercelOidc()`, `httpBasic()`, `jwtHmac()`, `jwtEcdsa()`, `oidc()`, plus the pure
verifiers `verifyHttpBasic`, `verifyJwtHmac`, `verifyJwtEcdsa`, `verifyOidc`,
`verifyVercelOidc`, and the walk helper `routeAuth(request, auth)`. `localDev()`
authenticates a synthetic principal only while the process is `eve dev` or
`vercel dev` — it never opens a production deployment, because that is a
property of the process, not of any request header.

The resolved principal reaches authored code as `ctx.session.auth` (hooks, tools,
approval policies), shaped `{ current: SessionAuthContext | null, initiator:
SessionAuthContext | null }` where `current` is the caller of the most recent
request and `initiator` created the session.

**Verified live, three ways.** (1) A stub `AuthFn` reading an
`x-spike-clerk-user-id` header placed **ahead of** `localDev()` won the walk, and
the hook observed `principalType: 'user', principalId: 'user_2abcClerk'` instead
of the local-dev fallback. (2) With the array reduced to that one custom entry,
an unauthenticated request returned exactly:

```
HTTP/1.1 401 Unauthorized
cache-control: no-store
www-authenticate: Bearer

{"code":"unauthorized","error":"Authorization is required for this route.","ok":false}
```

(3) With `localDev()` restored, the custom entry again won when its header was
present and `localDev()` supplied the fallback when it was not.

There is also a second, later seam: `eveChannel({ onMessage })` receives an
`EveHandle` with `{ caller, request, sessionId?, invocation? }` and returns
`{ auth, context?, title? }`, letting a channel choose session auth per message
and prepend context strings. T5–T8 should prefer the `auth` walk unless it needs
the per-message hook.

### Gaps found

1. **Model credential is required to complete a turn, and none is configured
   here.** `step.failed` / `turn.failed` with
   `code: "MODEL_CALL_FAILED"`, message
   `AI_RetryError: Failed after 3 attempts. Last error: GatewayResponseError: Invalid error response format: Gateway request failed: The model connection is unavailable. Run /login to reconnect.`
   A bare AI Gateway model id routes through the Vercel AI Gateway, which needs
   `/login`, a Vercel account, or a provider key. So the spike proves the mount,
   the auth walk, and hook delivery, but **not** a completed turn or a
   `turn.completed` hook. T8's evals need a real credential (an
   `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` plus a direct-provider model such as
   `anthropic()` from `eve/models/anthropic`) before they can run. Axiom
   currently has no model key in env at all.
2. **Repo-root `agents/` collides with eve workspace discovery** — see
   Project-root discovery above. Silent, and it breaks `withEve` entirely. Task 5
   must not drop the `eve/alfred/package.json` discovery marker without replacing
   it with an equivalent.
3. **Spec drift on the version.** The eng-review scope record cites
   `withEve()` "verified at eve@0.77.0"; npm installed **0.76.3**, which is what
   these shapes describe. Confirm the intended pin before Task 5.
4. **`eve dev` leaves artifacts under the agent root** — `.eve/` (compile,
   discovery, dev-runtime snapshots, sandbox cache) and `.output/`. **Both are
   now gitignored** (`.eve/` and `.output/`): the pre-existing `out/` rule did
   *not* cover `.output/`, which is a different path — verified with
   `git check-ignore -v eve/alfred/.output` (exit 0 after the fix, exit 1
   before). `pnpm build` does not leave `.output/` behind; `eve dev` does.
5. **The spike agent needs a `package.json` that `pnpm install` must tolerate.**
   It has no entry in `pnpm-workspace.yaml`, so it resolves `eve` through Node's
   ordinary upward lookup and adds nothing to the lockfile. Adding an entry would
   make it a workspace member — do not.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1d / CC: ~45min)** — Phase 0 spike — install eve + mount hello-world agent via withEve()
  - Surfaced by: Outside Voice #1/#4 — integration unvalidated; auth extension point assumed
  - Files: `package.json`, `next.config.ts`, `eve/alfred/` (throwaway spike)
  - Verify: `eve dev --no-ui` yields one real hook event into `run_events`; Clerk policy resolves AuthContext
- [ ] **T2 (P1, human: ~3h / CC: ~20min)** — `src/lib/auth.ts` — getAuthContext, withAuth, requireAuthContext
  - Surfaced by: Architecture Review — no auth code exists yet; Clerk→user→membership resolution lives in `src/domains/identity/`
  - Files: `src/lib/auth.ts`, `src/domains/identity/`
  - Verify: unit tests (unauthenticated, no-membership, auto-provision); 401 problem+json on `/api/v1/**`
- [ ] **T3 (P1, human: ~1d / CC: ~1h)** — `src/domains/agents/` — EveAgentEngine behind AgentEngine contract + event bridge
  - Surfaced by: Outside Voice #2/#6 — threads/messages unwired; bridge idempotency under retries
  - Files: `src/domains/agents/engine.ts`, `src/domains/agents/event-bridge.ts`
  - Verify: integration test — duplicate `(runId, sequence)` insert dedupes; `messages.runId` populated
- [ ] **T4 (P1, human: ~3h / CC: ~30min)** — `src/domains/spending/` — reserve/settle/release with advisory lock
  - Surfaced by: Outside Voice #5/#7 — budget concurrency; settlement from mid-run usage events
  - Files: `src/domains/spending/commands.ts`
  - Verify: integration test — two concurrent reservations race the last dollar, one wins
- [ ] **T5 (P2, human: ~4h / CC: ~40min)** — `agent/tools/` — domain read tools + approval-gated external proposals
  - Surfaced by: Decision — external writes become `action_proposals`, never direct calls (A09 executor later)
  - Files: `agent/tools/`, `src/domains/actions/`
  - Verify: unit test — external write attempt produces a proposal row, no provider call
- [ ] **T6 (P2, human: ~1d / CC: ~45min)** — policy evals (Vitest, real Neon)
  - Surfaced by: Phase C / ASH-112 acceptance — replay, tenancy, escalation, stale workers, revocation, races
  - Files: `tests/integration/`;
  - Verify: `pnpm vitest tests/integration` against Neon branch
- [ ] **T7 (P3, human: ~4h / CC: ~20min)** — routing/classifier evals (eve harness)
  - Surfaced by: Phase C item 11 — `evaluate()` + `auto()` with Axiom policy text
  - Files: `eve/alfred/evals/`
  - Verify: eve eval run produces pass/fail report

_Gates: T1 (Phase 0 spike) blocks T3–T5; T2 blocks everything._

_Suppressed findings: none — all 8 outside-voice findings were resolved or folded into D2–D5._

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex-plan-review (native Claude fallback) | Independent 2nd opinion | 1 | unavailable | 8 findings (Codex `AUTH_FAILED`; native fallback verified against repo/npm) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | issues_open | 5 issues, 0 critical gaps (prior 2026-10-10 run: 13 issues) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** codex (codex-plan-review) unavailable — `AUTH_FAILED` (codex-cli 0.162.1, not logged in). Native Claude subagent fallback completed: 8 findings, verified against repo and npm evidence, resolved as D2–D5. External coverage not established.

**VERDICT:** ENG review not CLEAR — issues_open (mapped to T1–T7, pending Phase 0 spike). eng review required. NO UNRESOLVED DECISIONS
