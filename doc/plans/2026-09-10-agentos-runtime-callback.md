# AgentOS runtime callback receiver

Status: implemented, pushed, and installed in the Paperclip app container;
the status-mutating AgentOS runtime E2E remains a separate controlled gate.

## Purpose

AgentOS is the policy, identity, quota, and action boundary. Paperclip remains
the company control plane and system of record for issues and heartbeat runs.
When an AgentOS-owned run finishes, AgentOS reports only a bounded terminal
result to Paperclip. Provider credentials, prompts, model output, and arbitrary
URLs do not cross this callback boundary.

## Contract

Paperclip exposes these internal routes below `/api`:

- `POST /agentos-runtime/v1/runs/:runId/attempts/:attempt/callbacks`
- `GET /agentos-runtime/v1/runs/:runId/attempts/:attempt/callbacks/:eventId`

The POST body is `{ eventId, payloadSha256, payload }`. The payload is a strict
`paperclip-runtime-callback/v1` object containing company, run, attempt, issue,
agent, terminal status, and either an output digest or a bounded error code.
The digest is SHA-256 over canonical JSON. The event id must equal the
`Idempotency-Key` header and the callback path/run/attempt must agree.

Authentication uses a dedicated bearer token plus an HMAC-SHA256 signature:
`v1;kid=<key>;ts=<unix-seconds>;sig=<hex>`. The signed value binds method,
path, timestamp, and raw-body digest; timestamps older than 60 seconds are
rejected. The callback router validates the signature against the captured raw
body before interpreting the callback payload and is mounted before Paperclip's normal actor
middleware so this token cannot be interpreted as a board or agent API key.

## Persistence and replay

The receiver locks the target `heartbeat_runs` row, accepts only queued/running
runs with matching company and agent identities, and atomically:

1. projects `succeeded`/`failed` plus the callback receipt into `resultJson`;
2. projects failed callbacks into both Paperclip's human-readable `error` and
   canonical machine-readable `errorCode` fields (and clears both on success);
3. writes `heartbeat.runtime_callback.accepted` to `activity_log`.

The same event and digest are a safe replay and return the same receipt. A
different event or digest for an already recorded run is rejected. The GET
receipt is the AgentOS readback source; it is authenticated by the callback
token and never requires a normal Paperclip API-key actor.

## Configuration and rollout

The receiver is disabled unless all three environment variables are present:

- `PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_TOKEN`
- `PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_SIGNING_SECRET` (32–4096 bytes)
- `PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_SIGNING_KEY_ID`

No schema migration is required: the callback metadata is stored in the
existing heartbeat-run `resultJson`, while the audit entry uses the existing
`activity_log` table. Enable the receiver only together with the matching
AgentOS callback configuration and a live, read-only-then-controlled E2E. Keep
AgentOS runtime execution disabled until both sides are deployed and the
signed POST, replay, GET receipt, and final status projection have been
verified.

## Pattern & Pulse image publication and host cutover (2026-09-10)

The Pattern-Pulse organization keeps its Actions policy in `selected` mode;
the upstream Paperclip workflows therefore stop at `startup_failure` because
they reference unapproved marketplace actions. The repository contains the
narrowly scoped `.github/workflows/pattern-pulse-container.yml` fallback. It
uses only GitHub-owned `actions/checkout@v7`, builds the `production` target
for the amd64 host, and publishes a full-commit-SHA tag to GHCR.

The fork is now on `master` at
`2e053f5054b8e3406e6597b58b03f47287f5883c`, including the upstream sync
commits `9581a9af0` and `99f5afdd9` plus the packaging fix that makes
`smol-toml` a direct server runtime dependency. The independent code and
workflow review is PASS. The fallback workflow passed as run
`34421638580`, with strict digest readback:
`ghcr.io/pattern-pulse/paperclip:sha-2e053f5054b8e3406e6597b58b03f47287f5883c@sha256:5d32565c27ac39e4ae4f78df35d3fe6f70f13fa5046bf34fa82b9acb4b055212`.

Because GHCR remains private (`401` anonymously; the current GitHub token has
no `read:packages`, and the host has no registry credentials), the host cutover
used a local, content-addressed Docker archive instead of a registry pull. The
archive SHA-256 is
`69c7cc8b7c50b6c2ff6743e355ecd224d06100a00fabc4a3d99fd747f4d90edc`; the
loaded image ID is
`sha256:00944112cf96efd8e9ab647f44c9a27c57795c120651f1d6983a465042551ff6`,
and its build-info commit is the fork HEAD above. The image passed both the
production Docker `require.resolve` guard and a real ESM import smoke from the
vendored runner path. Only `agentos-paperclip-app` was recreated; it is
`running healthy` with restart count `0`, the PostgreSQL container ID is
unchanged, and Plane/AgentOS containers were untouched.

The callback environment is now present in the Paperclip app, but the AgentOS
runtime gateway/execution flags remain disabled. Live read-only acceptance is
proved by `/api/health` returning the exact build commit, an unauthenticated
empty-body callback returning `401 callback_unauthorized`, and a correctly
signed callback for an unknown run returning `404 run_not_found` without a
write. A terminal-only database state
currently has no queued/running run, so a real status-mutating callback E2E is
still a separate controlled gate; do not claim the full Paperclip-to-AgentOS
runtime loop is live until that gate is executed.

### Cutover incident and recovery chronology

The first app-only cutover on `99f5afdd9` failed during container startup:
the production image could not resolve `smol-toml` from the vendored Codex
runner path. The host was immediately rolled back to the prior official
Paperclip image; app health, restart count, and the PostgreSQL container
identity returned to the pre-cutover state. Commit `2e053f505` then made the
server runtime dependency explicit, passed the production resolve guard and a
real ESM import smoke, and was installed only after that evidence was green.
