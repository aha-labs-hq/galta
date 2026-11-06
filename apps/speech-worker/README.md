# Recorded speech

Galta's default recognizer is Cloudflare Workers AI
`@cf/openai/whisper-large-v3-turbo`. It detects language automatically. Only an
explicit Send uploads mono 16 kHz PCM16 audio; no canvas, pointer, video or chat
history reaches this service. A recording is at most 60 s. Hosted transcription
uses the person's existing verified Aha Labs account; local capture stays available
signed out. The model receives only audio, never account credentials.

## Account and admission

The account host exchanges its existing session at `POST /v1/authorize`. The
speech Worker verifies that session with the Aha Labs account Worker through a
service binding, including verified email, subject and expiry. It retains none of
the session response. Only the host uses the long-lived bearer; the recording
page receives an opaque, random capability valid for two minutes, bound to its
recording ID and SHA-256 audio digest. It is consumed atomically once before AI.
Changing Origin, recording ID, audio or a claimed user ID cannot mint authority.

`SpeechBudget` owns a SQLite Durable Object per upstream credential. It only
serializes tiny admission transactions, not uploads or inference. Every account
has six grants per minute and 1,800 admitted audio seconds per UTC day; all
accounts share a 10,000-second daily ceiling. Each admission reserves rounded-up
seconds, at least five, before starting the model. At the documented model rate
of 46.63 Neurons/minute, that ceiling is approximately 7,772 Neurons, leaving
headroom within the account's free allowance. This is a conservative reservation
budget, not live billing: failed or interrupted inference is not refunded because
upstream work may already have occurred. Other Workers AI uses still share the
Cloudflare account allowance. Review these constants with model/pricing changes.

The ledger contains only hashed account IDs, counters and short-lived grants
(recording ID, audio digest, random token and expiry). A daily cleanup alarm
removes expired records; there is no polling, audio or transcript persistence.
Grant replay remains refused across Worker restarts. Previously issued grants can
outlive sign-out by at most two minutes; new grants always revalidate the session.

Signed-out Send opens the existing Account view and preserves the original; login
does not auto-send. Signed-in use adds no prompt or CAPTCHA. The extension and
local preview use the same account lifecycle; the local preview stores its own
session in its private data directory and supports emailed codes. Google handoff
remains extension-only. Codex sign-in is separate and never supplies this identity.

The browser's short-lived worker computes 20 ms acoustic activity and conservatively
removes quiet gaps, retaining 350 ms margins and all sounds above a low noise
floor, including brief sounds excluded from activity classification. PCM samples
are not stretched or synthesized. Exact sample intervals map Whisper times back
to the original recording; a word crossing a splice retains multiple spans.
Whisper VAD runs on the uploaded copy. The existing evidence timeline uses original
acoustic activity, not response arrival or the final pointer position. Neither
energy nor word timing is a guaranteed speech alignment. Counts and scope remain
the agent's judgement; ambiguity must not be silently converted into an edit.

## Boundaries

- One model call per submission; no automatic retries or Apple fallback.
- 45 s service deadline, 55 s client network deadline; cancellation propagates to
  the AI binding. `enable_request_signal` is required for the deployed runtime to
  notify the handler when the client disconnects; a synthetic Request in a unit
  test does not verify this platform setting. A provider may already have started
  work when cancellation arrives.
- Binary request body capped while streaming at 1,920,044 bytes, strict WAV and
  response validation, no canvas fields accepted. Validated WAV is passed to the
  AI binding as a binary stream, with no Base64/JSON expansion. No cookies or provider tokens
  in the browser. Responses are not cached.
- No persistent audio or transcript storage, queue or analytics SDK. Application
  logs contain only status, elapsed milliseconds and duration, never credentials.
- An approximate 60-request/minute IP guard rejects floods before account work.
  Account limits are strict across locations, devices and changing IP addresses;
  people sharing a network keep separate account budgets. Origin/CORS is not auth.
  Distributed abuse using many verified accounts can still consume the shared
  admission budget; identity and limits are mitigation, not unlimited availability.
- Operate on **Workers Free**. Its account-wide 10,000-neuron daily allowance
  resets at 00:00 UTC and hard-stops inference at exhaustion. Do not upgrade the
  account to Paid without adding and verifying an independent spend boundary.
  A local burst limiter is not a billing limit. Exhaustion/offline/failure leaves
  the local recording intact, with explicit retry after the user sees the error.
- The old native Apple speech protocol remains for older installed clients;
  historical Apple transcripts stay readable. New clients use Cloudflare only.

## Operations

`wrangler.jsonc` owns production and staging configuration. An operator must use
an authorized Cloudflare profile; no credential belongs in source or a client.
Deploying the Worker does not release or update the browser extension/Mac app.

The zone-level WAF custom rule in [`edge-rule.json`](edge-rule.json) rejects
unsupported paths and methods on the speech hostname before Worker execution.
It admits only `POST`/`OPTIONS /v1/transcribe`, `POST`/`OPTIONS /v1/authorize`,
and `GET /health`; it does not
authenticate clients or replace the Worker's origin, payload and rate checks.
Install it separately in the zone's `http_request_firewall_custom` ruleset,
preserving unrelated rules. Self-hosters must adapt the hostname. This rule is
available on the Free zone plan and needs no extra Worker or polling service.
Wrangler deployment does not install WAF rules. To roll this rule back, disable
only this rule; the Worker still rejects unsupported requests itself.

Verify the rule with an unknown path (blocked at the edge), `/health` (200 while
enabled), a valid-origin preflight (204), and an unsigned recording POST (401,
without inference). Compare Worker invocations with zone HTTP analytics:
preflights, blocked scans, managed robots responses and redirects are not model
calls. Adaptive analytics can lag and estimate totals; do not equate counts
from different datasets or a runtime `success` with HTTP 200. A client-disconnected
invocation with HTTP 499 is not evidence of exhausted AI allowance.

```sh
bun run --cwd apps/speech-worker types
bun run typecheck
bun test tests/cloud-speech.test.mjs tests/speech-admission.test.mjs
node scripts/verify-speech-admission.mjs
bun run --cwd apps/speech-worker dry-run
# Configure the authorized account/profile in the environment, then:
bunx wrangler deploy --config apps/speech-worker/wrangler.jsonc --env staging --var ENABLED:true
bunx wrangler deploy --config apps/speech-worker/wrangler.jsonc --env=""
```

Before deployment, verify the target account is still Workers Free. Test `/health`
without inference, request rejection, and an authorized recording on staging.
Staging defaults to disabled; enable it explicitly for a bounded experiment, then
deploy it again without the override to suspend inference. Check transcription
coverage and original-clock evidence, not merely HTTP 200.
Record deployment version IDs and actual inference latency. Logs and Server-Timing
separate service preparation from upstream inference; they contain no transcript.

For a regression, deploy the previous **speech Worker** version with Wrangler
rollback, or change `ENABLED` to `false` and deploy to suspend new inference. Do not
roll back the website or silently route audio elsewhere. A disabled service
returns an explicit error and keeps the sent original available for Restore. Quota is shared
with other Workers AI uses on the account; readiness does not promise remaining
allowance. Keep privacy disclosure current before distributing a client build.

The service source contains no account IDs or secrets and is part of the public
source export. Self-hosters deploy their own service and change `CLOUD_SPEECH_URL`
in the capture contract, bind their account authority and implement the same
verified-session response contract. Application tests mock the speech endpoint and never
spend inference allowance. Real-sample evidence stays outside public source.

Roll out the account-capable client before enforcing this server contract. Older
anonymous clients receive an explicit update/sign-in error and keep their draft;
there is deliberately no anonymous bypass. Deploying this Worker does not update
an installed extension. SQLite DO migrations prevent rolling back to a version
without the class; keep the admission class or disable speech instead.

References: [model contract](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/),
[free allowance](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[rate limiter semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[data use](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
