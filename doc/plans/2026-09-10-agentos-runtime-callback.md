# AgentOS runtime callback receiver

Status: implemented in the Paperclip bridge worktree; deployment remains a
separate release decision.

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

## Pattern & Pulse image publication (2026-09-10)

The Pattern-Pulse organization keeps its Actions policy in `selected` mode;
the upstream Paperclip workflows therefore cannot start because they reference
unapproved marketplace actions. The repository now contains the narrowly
scoped `.github/workflows/pattern-pulse-container.yml` fallback. It uses only
the GitHub-owned `actions/checkout@v7`, builds the `production` target for the
amd64 host, and publishes a full-commit-SHA tag to GHCR. The workflow was
independently reviewed and passed on commit
`de655b44747b9088bfe40a7c0a8676a99bd3cdac` (run `34414562754`), including a
strict digest readback:
`ghcr.io/pattern-pulse/paperclip:sha-de655b44747b9088bfe40a7c0a8676a99bd3cdac@sha256:cd5ba5cf090949a33210377fe90e77588b5d8b451c5510486a4ac50c4c082f3a`.

The host cutover is intentionally still open. The package is not anonymously
pullable (`ghcr.io` returned HTTP 401), the current GitHub token lacks
`read:packages`, and the host has no Docker registry credentials. The running
host remains on the upstream Paperclip image; neither the Paperclip database
nor callback environment was changed. Install the image only after a
least-privilege read credential or an explicitly approved package-visibility
decision is available, then perform a Paperclip-app-only recreate and the
signed callback E2E.
