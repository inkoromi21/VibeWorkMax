# Mini app public API extension

The reverse proxy exposes these routes under `/api/mini-app/*`; the Fastify process keeps the
internal `/mini-app/*` prefix. All protected mutations require the session cookie, CSRF header,
current state `revision`, an `Idempotency-Key`, and a successful common access/consent decision.

## Canonical diagnostics

- `POST /api/mini-app/diagnostic-profile` creates the canonical PostgreSQL session and issues its
  first question.
- `POST /api/mini-app/diagnosis` accepts `questionInstanceId` and `sessionRevision` for answer,
  skip, and unknown actions.
- Both diagnostic responses expose `session_id`, `question_instance_id`, `session_revision`, and
  `public_question`. The public question never contains the answer key or scoring policy.
- A repeated idempotency key returns the durable answer and repairs a missing next-question issue
  after a worker/process interruption.

## Learning and user data

- `GET /api/mini-app/routes/active`
- `GET /api/mini-app/progress`
- `POST /api/mini-app/attempts`
- `GET /api/mini-app/attempts/{attemptId}/review` (latest immutable review version)
- `POST /api/mini-app/disputes`
- `POST /api/mini-app/attachments` (returns `SCANNER_UNAVAILABLE`; files are not accepted until a scanner is connected)
- `POST /api/mini-app/export-requests`
- `GET /api/mini-app/export-requests/{requestId}/download`
- `POST /api/mini-app/deletion-requests` (`PENDING_POLICY` until retention policy approval)
- `POST /api/mini-app/attachments`: JSON with `attemptId`, `mimeType`, `contentBase64`, and current `revision` (max 5 MiB decoded); requires CSRF and `Idempotency-Key`. Bytes stay in a private quarantine until ClamAV returns clean. Without a scanner the response is `202 QUARANTINED`, never an accepted attachment. This demo adapter requires `S3_MODE=local` and an absolute `ATTACHMENT_LOCAL_DIR`; production S3 upload is not enabled.

Export downloads are owner-scoped, expire after 24 hours, and use `private, no-store`. The MAX
Bridge receives only the URL of a ready server-generated export.

An attempt returns `PENDING` until the worker publishes a new `READY` review version. Repeating the
same idempotency key returns the same attempt and its latest review; it does not create a new attempt.
