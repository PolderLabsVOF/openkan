# Chat daemon plan

> Research-grounded plan for `tsk-KBumlNUh`. Captures the current chat architecture, the microsoft/agent-host-protocol evaluation, and the recommended path forward.

## Goals and non-goals

Goals:
- Decouple chat session lifecycles from the OpenKan web UI: agents keep running after the browser tab closes.
- Survive brief server restarts and let clients resume mid-flight by replaying missed events.
- Introduce `openkan serve` (the user's preferred name for the long-running mode) as the canonical entry point.
- Keep local-first semantics: no remote auth, no external services, all state under `.ok/`.

Non-goals:
- Multi-host sync across machines (this is single-host, multi-client).
- OAuth2 / cross-tenant auth.
- A full replacement of the existing `claude -p` subprocess pipeline; the daemon is a wrapper, not a new agent runtime.
- Adopting every AHP surface (terminals, automations, OTLP, MCP, changesets, annotations).

## Current architecture

Source map (all paths absolute under `/home/drb0rk/projects/openkan`):

- `kanban/chat.ts` — owns JSONL session storage at `.ok/sessions/<sid>.jsonl`, the `claude -p --output-format stream-json --verbose` subprocess wrapper, and the `handleChatRequest` dispatcher. Key internals:
  - `runningProcs: Map<string, RunningProcess>` (line 574) — in-memory PID registry used by `abortSession` (line 603).
  - `sendTurn` (line 957) — appends a user turn, then `spawn`s `claude` with stream-json + `--include-partial-messages --include-hook-events --forward-subagent-text`. Returns immediately; the child runs detached from the HTTP request.
  - `chatSseControllers` (line 1120) and `sessionChatSseControllers` — per-project and per-session SSE controller sets used to broadcast `chat.status`, `chat.activity`, `chat.turn`, `text_delta`, `tool_use`, `tool_input_delta`, `tool_result`, `message_done`.
  - HTTP routes mounted in `handleChatRequest` (line 1218): `GET /api/chat/sessions`, `GET /api/chat/sessions/:sid`, `DELETE /api/chat/sessions/:sid`, `POST /api/chat/sessions/:sid/abort`, `GET /api/chat/sessions/:sid/events`, `POST /api/chat/send`, `GET /api/chat/events`, `GET /api/chat/selectors`, `GET /api/chat/picker-options`, `POST /api/chat/render-markdown`.
- `kanban/server.ts` — chat routes mounted at line 2814: `if (path.startsWith("/api/chat/")) return handleChatRequest(projectRoot, req, path)`.
- `web/chat-sidebar.js` — opens/closes sessions against the `/api/chat/*` surface via the `api()` helper; subscribes to `/api/chat/sessions/<sid>/events` with `EventSource` (auto-reconnect at line 746).
- `bin/openkan.ts` — has `start`, `stop`, `status`, `logs`, `agent`, `board` subcommands (lines 592-607). No `serve` exists yet — `cmdStart` (line 187) currently is the entry. `cmdMcp` is a stub (line 708).
- `package.json` — entry `bin/openkan.mjs`, deps include `ws@^8.21.1` (already present, unused by chat today), `nanoid@^5.0.0`.

Observed behaviour vs. user framing: the `claude` subprocess is owned server-side via `child_process.spawn`, and `sendTurn` is fire-and-forget — closing the browser tab does not directly kill the subprocess. The real coupling is server↔process: if the `openkan` server dies, the in-memory `runningProcs` Map is lost and PIDs become orphaned (or, after a future fix, killed). The user's "agents stop when UI closes" framing is therefore most accurate when the operator runs `openkan start` in a foreground terminal tied to the browser session. The daemon work addresses both the foreground-coupling and the missing replay-on-reconnect capability.

## agent-host-protocol overview

Researched via WebFetch from `https://github.com/microsoft/agent-host-protocol` and `https://microsoft.github.io/agent-host-protocol/`. Verbatim facts (file references inside the upstream repo):

- **Purpose.** "A portable, standalone server protocol that gives multiple clients a synchronized view of AI agent sessions through immutable state, pure reducers, and write-ahead reconciliation." MIT-licensed, 829 commits on `main`, active. VS Code is the reference server. Client SDKs ship for Rust, TypeScript, Kotlin, Go, Swift, .NET — each on its own SemVer track.
- **Wire format.** JSON-RPC 2.0 envelopes (`schema/commands.schema.json`, `schema/notifications.schema.json`, `schema/errors.schema.json`) over a transport-agnostic channel. Every `params` object carries a `channel: URI` for routing. Channels observed: `ahp-root://`, `ahp-session:/<uuid>`, `ahp-chat:/<cid>`, `ahp-automations://`, `ahp-automation-run:/<id>`, `ahp-otlp:` (OTLP/JSON telemetry), plus terminal/MCP/changeset/annotation channels. Schema set: `schema/state.schema.json`, `schema/actions.schema.json`, `schema/commands.schema.json`, `schema/notifications.schema.json`, `schema/errors.schema.json`.
- **Actions (~100 types).** All carry a `serverSeq`; many carry `origin` and `clientSeq` for reconciliation. Highlights relevant to chat: `chat/turnStarted`, `chat/delta`, `chat/responsePart`, `chat/toolCallStart`, `chat/toolCallDelta`, `chat/toolCallReady`, `chat/toolCallConfirmed`, `chat/toolCallComplete`, `chat/turnComplete`, `chat/turnCancelled`, `chat/error`, `chat/turnResume`, `chat/reasoning`, `chat/usage`, `chat/truncated`, `chat/turnsLoaded`, `chat/pendingMessageSet`, `chat/inputRequested`, `chat/inputAnswerChanged`, `chat/inputCompleted`. Plus session/root/terminal/changeset/annotations/automation/resourceWatch namespaces.
- **Notifications (8 types).** `AuthRequiredParams`, `SessionAddedParams`, `SessionRemovedParams`, `SessionSummaryChangedParams`, `ProgressParams`, `OtlpExportLogsParams`, `OtlpExportTracesParams`, `OtlpExportMetricsParams`.
- **Transport.** Spec explicitly states: "Any mechanism providing a reliable, ordered, bidirectional message stream can carry AHP messages." Transport is agreed out-of-band; no negotiation. WebSocket is recommended (and what VS Code uses). TCP-with-framing and in-process channels are acceptable. There is no default transport inside the spec.
- **Lifecycle.** `initialize` request carries `protocolVersions` (SemVer) plus initial subscriptions + locale; server replies with negotiated version + sequence. On disconnect, client sends `reconnect` with its last-seen `serverSeq`; server replays missed actions, or returns full snapshots if the gap exceeds buffer, with `missing[]` for unavailable subscriptions.
- **Auth.** Bearer tokens via an `authenticate` command. Protected resources use RFC 9728 OAuth 2.0 Protected Resource Metadata. Missing-token errors use code `-32007` (`AuthRequired`). The TypeScript SDK exposes `AuthRequiredParams` and `ProtectedResourceMetadata` types in the schema.
- **Persistence / runtime model.** Spec does not prescribe persistence; it positions one host as the authoritative state owner between multiple clients and multiple agents. Server (the host) owns the write-ahead log; clients apply actions optimistically and reconcile via `serverSeq`+`origin` matching.
- **Maintenance.** MIT, actively maintained, 829 commits at time of research (Sep 2026). Independent SemVer per language SDK.

## Fit evaluation

| Concern | AHP says | OpenKan today | Gap |
|---|---|---|---|
| Sessions / chats | First-class: `ahp-session:/<uuid>`, `ahp-chat:/<cid>`, `SessionState`, `ChatState`, `SessionSummary` in `state.schema.json`. | First-class: `ChatTurn` JSONL in `.ok/sessions/<sid>.jsonl`, `ChatState` rebuilt per-request. | Small. Concepts line up. |
| Reconnect / replay | `reconnect` with last `serverSeq`; replay buffer + snapshot fallback with `missing[]`. | None. Closing SSE loses pending activity; client re-fetches transcript via `GET /api/chat/sessions/<sid>` but does not resume the in-progress stream. | Large. AHP's pattern is exactly what the feature needs; OpenKan has no equivalent. |
| Subprocess / tool lifecycle | `chat/toolCallStart/Delta/Ready/Confirmed/Complete/AuthRequired/AuthResolved/ContentChanged/ResultConfirmed`; `chat/turnResume` for errored turns; `_meta` for provider-specific metadata. | Tool events emitted as `tool_use`, `tool_input_delta`, `tool_result` on the SSE channel with `chat.turn` rollups. | Medium. OpenKan's existing event names can map 1:1 to AHP names if we adopt. |
| Streaming | `chat/delta` with `turnId`+`partId`+`content`. | `text_delta` with parent-turn scoping. | Trivial rename. |
| Input requests (mid-turn questions) | `chat/inputRequested`, `chat/inputAnswerChanged`, `chat/inputCompleted`, plus session-level `session/inputNeededSet/Removed`. | Not modeled (Claude CLI is non-interactive; no mid-turn user prompt today). | Future-facing. AHP models it; OpenKan can stub it now. |
| Transport | Transport-agnostic JSON-RPC; WebSocket recommended (bidirectional, ordered). | SSE (one-way server→client) + REST POST. `ws@^8.21.1` is in deps but unused. | Medium. AHP assumes bidirectional JSON-RPC over WS; OpenKan's UI currently consumes SSE. Two options: switch to WS, or keep SSE for the streaming channel and add a separate JSON-RPC POST channel for commands. |
| Multi-client sync | Core design. Optimistic dispatch + `serverSeq` reconciliation, `origin` tracking. | Single-client assumption. `chatSseControllers` is a `Set` per scope; broadcasts fan out. | None if we stay single-client; medium if we want true multi-client replay safety. |
| Auth | OAuth 2.0 Bearer + RFC 9728. `AuthRequired` error code. | None. Loopback-only (`--host` validates to 127.0.0.1/localhost/::1 in `bin/openkan.ts` line 402). | Large if adopted; trivial if explicitly skipped. |
| Persistence | Not prescribed. Spec is transport-and-state-shape agnostic; server owns the WAL. | JSONL on disk under `.ok/sessions/`. | None. JSONL is a fine WAL. |
| Server reference | VS Code AHP host. | `kanban/server.ts` `startOrAttach` + Node `http`. | None (we keep our own). |
| Telemetry (OTLP) | Three OTLP/JSON notifications. | None. | Out of scope for v1. |
| Terminal / automations / changesets / annotations / MCP channels | First-class. | None. | Out of scope; ignoring these shrinks the surface dramatically. |
| Schema discipline | JSON Schema 2020-12, generated from `types/`. `x-` reserved for extensions. | TypeScript types in `kanban/chat.ts`. | Adoption requires generating a public schema file under `docs/` for cross-team clients. |
| Maintenance | MIT, active, 829 commits, 6 SDKs. | Local repo. | Independent; not a factor. |

## Recommendation

**(c) Use AHP as inspiration, but roll a leaner internal protocol.** Adopt AHP's three load-bearing ideas — channel-URI routing, immutable action envelopes with `serverSeq`, and reconnect-with-replay — and drop everything else (terminals, automations, OTLP, MCP, changesets, annotations, OAuth2). Concretely:

- Define a public schema at `docs/ok-chat-protocol.schema.json` for a `ok-chat:/<sid>` channel plus a `ok-session:/<sid>` summary channel. Generate from TS types the same way AHP does.
- Wrap every chat event in `{ channel, action, serverSeq, origin?, rejectionReason? }`. Persist envelopes (not raw Claude stream events) to `.ok/sessions/<sid>.jsonl` so they double as the replay log.
- Add a `reconnect` command that takes `lastServerSeq` and replays the WAL since that seq.
- Keep SSE as the primary streaming transport for the UI (preserves `web/chat-sidebar.js` EventSource path). Add a thin JSON-RPC POST command channel only for actions that need to flow client→server while a turn is active (currently: abort and answer). This stays transport-agnostic.
- Skip OAuth2 entirely. Loopback-only auth via the existing `--host` validator.
- Wire `openkan serve` as an alias for the long-running form of `openkan start` (PID file at `.ok/server.pid`, logs at `.ok/server.log`, `openkan stop`/`status` already work). Add `openkan serve --detach` for true background mode.

A full AHP adoption would force ~5 unused channel surfaces into OpenKan, require a WebSocket refactor of the sidebar, and impose OAuth2 on a tool that is intentionally loopback. The leaner protocol preserves the daemon-replay value (which is the actual feature ask) without those costs.

## Proposed architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       OpenKan daemon                            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ ok-chat-protocol host  (chat-protocol/)                   │   │
│  │   - write-ahead log: .ok/sessions/<sid>.jsonl            │   │
│  │   - action envelopes: { channel, action, serverSeq, ... }│   │
│  │   - reducers: session/chat/root summaries                 │   │
│  │   - reconnect(lastServerSeq) → replay or snapshot         │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ▲                ▲                  ▲                │
│   SSE(/api/chat/events)   POST /api/chat/send   POST /api/chat/ │
│            │                │                  reconnect         │
│            │                │                  abort, answer     │
│  ┌─────────┴────────────────┴──────────────────┴────────────┐   │
│  │   HTTP server (kanban/server.ts, /api/chat/*)             │   │
│  └──────────────────────────────────────────────────────────┘   │
│            ▲                                                    │
│   ┌────────┴─────────┐   ┌───────────────────────────────┐     │
│   │ web/chat-sidebar │   │ future: ok CLI / mobile       │     │
│   │  (EventSource)   │   │ clients over WS               │     │
│   └──────────────────┘   └───────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
            │
            ▼
   claude -p --output-format stream-json --verbose  (per turn)
```

Components:

1. **`chat-protocol/` (new).** Hosts the schema, the typed envelope, the action union (subset of AHP), the reducers, and the replay logic. Generated JSON Schema lives at `docs/ok-chat-protocol.schema.json`.
2. **`kanban/chat.ts` (modified).** `sendTurn` keeps its `claude -p` subprocess wrapper but emits AHP-style envelopes to the WAL before broadcasting on SSE. The SSE handler becomes a thin projection of the WAL+live-stream; reconnect replays from the WAL.
3. **`kanban/server.ts` (minor).** Two new routes: `POST /api/chat/reconnect` (with `lastServerSeq`) and `POST /api/chat/abort` already exists. The dispatcher gains a `serveMode` flag for the daemon's lifecycle hooks (PID, log, signal handlers).
4. **`bin/openkan.ts` (modified).** `cmdServe` is `cmdStart` with `--detach` semantics (fork + PID file + `openkan.log` redirection). `cmdStart` becomes a thin wrapper around `cmdServe` for backwards compatibility.
5. **`web/chat-sidebar.js` (modified).** On `EventSource` reconnect, if the connection drops mid-turn, the client calls `POST /api/chat/reconnect { sessionId, lastServerSeq }` to backfill missed envelopes. No structural rewrite; one new path.
6. **Schema docs (`docs/ok-chat-protocol.schema.json`, `docs/chat-daemon-plan.md`).** Public contract for future clients and a durable plan record.

WAL shape (one JSON object per line):

```json
{"channel":"ok-session:/s1","action":{"type":"session/summaryChanged","changes":{"title":"Refactor auth"}},"serverSeq":17,"ts":"2026-09-05T12:00:00Z"}
{"channel":"ok-chat:/s1","action":{"type":"chat/turnStarted","turnId":"t9","startedAt":"...","message":"..."},"serverSeq":18,"ts":"..."}
{"channel":"ok-chat:/s1","action":{"type":"chat/delta","turnId":"t9","partId":"p1","content":"Looking"},"serverSeq":19,"ts":"..."}
{"channel":"ok-chat:/s1","action":{"type":"chat/toolCallStart","turnId":"t9","toolCallId":"u1","toolName":"Read","displayName":"Read"},"serverSeq":20,"ts":"..."}
{"channel":"ok-chat:/s1","action":{"type":"chat/toolCallComplete","turnId":"t9","toolCallId":"u1","result":{...}},"serverSeq":21,"ts":"..."}
{"channel":"ok-chat:/s1","action":{"type":"chat/turnComplete","turnId":"t9","duration":4231},"serverSeq":22,"ts":"..."}
```

This is a strict subset of AHP's chat/* action vocabulary, plus a `serverSeq` per envelope. A future migration to full AHP becomes a 1:1 schema lift (add terminals/automations/OTLP/etc.) rather than a rewrite.

## Phased delivery

Each phase is one logical commit, paired with a docs/test change.

**Phase 1 — protocol shape (no behavior change).**
- Add `chat-protocol/types.ts`, `chat-protocol/envelope.ts`, `chat-protocol/reducers.ts`.
- Generate `docs/ok-chat-protocol.schema.json` from types using the same generation pattern AHP uses (manual JSON Schema 2020-12 file checked in for v1; automate later).
- Unit tests for envelope serialisation and reducer purity (no I/O).
- `make check`, `make test` green. `make e2e` green.
- Commit: `feat(chat-protocol): introduce envelope, channel URI, and reducers`.

**Phase 2 — WAL and replay.**
- Replace raw Claude stream events in `.ok/sessions/<sid>.jsonl` with envelopes (one line per envelope). Add a migrator for any pre-existing session files.
- `POST /api/chat/reconnect { sessionId, lastServerSeq }` returns `{ events: [...], missing: [...] }` (or a full snapshot if `lastServerSeq` is too old).
- Tests: replay from middle of WAL, replay after restart, replay with `lastServerSeq` beyond buffer.
- Commit: `feat(chat): add write-ahead log and reconnect replay`.

**Phase 3 — `openkan serve` and daemon lifecycle.**
- New `cmdServe` in `bin/openkan.ts`: forks into background, writes `.ok/server.pid`, redirects stdout/stderr to `.ok/server.log`, installs SIGTERM/SIGINT handlers that drain the WAL on shutdown.
- `openkan start` becomes a forwarder to `serve` for backwards compatibility; `serve --foreground` keeps the existing foreground behaviour.
- `openkan stop`/`status`/`logs` unchanged; they read `.ok/server.pid` already.
- Tests: PID-file collision, stale-PID detection, signal handling.
- Commit: `feat(cli): add openkan serve as the long-running daemon mode`.

**Phase 4 — sidebar reconnect integration.**
- `web/chat-sidebar.js` tracks `lastServerSeq` per session in `state`, calls `POST /api/chat/reconnect` on `EventSource` reconnect when the gap is non-zero, applies returned events before resuming the live stream.
- Tests: simulated drop mid-turn, snapshot path when buffer exceeded.
- Commit: `fix(chat-sidebar): backfill missed envelopes on SSE reconnect`.

**Phase 5 — docs + observability (optional).**
- Add `chat-protocol/README.md` describing the public contract.
- Optional OTLP exporter for chat envelope traces (mirrors AHP's `OtlpExportTracesParams` shape) — only if user demand appears. Skip for v1.
- Commit: `docs(chat-protocol): document the public schema`.

## Open questions

1. **What is the WAL retention policy?** AHP assumes the host owns the WAL with some bounded buffer. OpenKan's JSONL currently grows without bound per session. We need a compaction strategy (e.g., snapshot every N envelopes + delta) before this scales, otherwise the replay buffer claim is hollow.
2. **Do we ever need true bidirectional WebSocket, or is the SSE + command-POST split sufficient?** Today's UI is one-way-streaming with sparse control events. If a future client (CLI REPL, mobile) needs real-time bidirectional push, we'd add WS. We should decide this before locking the protocol, since it constrains the transport section.
3. **Should `claude` subprocess ownership move out of `kanban/chat.ts` into the daemon, or stay where it is?** The daemon needs PID survival across `serve` restarts. Today `runningProcs` is an in-process Map. Either (a) the daemon reaps orphaned children on startup via `pidfile` per session, or (b) the daemon spawns `claude` indirectly through a worker process that itself supervises. This is the highest-risk design call in the plan and warrants a spike before Phase 3.

---