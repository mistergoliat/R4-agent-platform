# R4 Inbound multimodal v1: images and voice notes

**State:** `R4_INBOUND_MULTIMODAL_V1_IMPLEMENTED_PENDING_REVIEW`. The code is behind `R4_MEDIA_PERCEPTION` (off by default). It is not deployed and changes nothing in `sales-production@19` while it stays off.

## Owner decisions (2026-11-11)

- **Images:** `deepseek-flash` through the official DeepSeek API, the provider the conversation already uses. No OpenAI Vision.
- **Voice notes:** OpenAI `gpt-transcribe`, used only for transcription, behind an interchangeable adapter so Deepgram can replace it later.
- **Conversation:** same model and configuration as today. Replies are always text.
- **Unchanged:** Catalog V2 remains the commercial authority. Quote, Checkout and the commercial capabilities of `sales@19` do not change.
- **Order of work:** validate with real audios and photos in an isolated environment before any deploy. Every canary needs authorization by SHA.

## 1. Architecture audit (before the change)

| Component | What existed | Reused | Minimal change |
|---|---|---|---|
| Webhook (`apps/channel-gateway`, `ChannelIngress.receive`) | Fastify route; raw body for the HMAC; 1 MiB limit; 200 only once each item is durable | Yes | None |
| Signature (`WhatsAppInboundAdapter.authenticate`) | `X-Hub-Signature-256` mandatory, `timingSafeEqual`, fails closed | Yes | None |
| Dedupe | `inbound_events unique (channel, provider_event_id)` plus `task_inputs unique (task_id, source_ref, external_key)` | Yes | None |
| Parser (`inbound.ts`) | Only `text`. Image and audio became `unsupported`, and the media id and caption were **dropped** | Yes | `image`/`audio` branches that keep the media **reference** |
| Canonical contract (`live-ops/channel.ts`) | `text` or `unsupported` | — | `media` variant: reference, mime, hash, caption, voice |
| Graph client | Outbound only (send, upload). No media download anywhere | Config pattern, `fetch` injection | `WhatsAppMediaDownloader` |
| Who holds the WhatsApp token | Gateway only; the worker never loads it | Yes | Download in the gateway |
| Persistence (`inbound_events`) | `content_kind` limited to text, unsupported and rejected; content is cleared at settlement | Yes | Migration `0016`: adds kind `media` |
| Binaries in Core | Only `outbound_documents.bytes` (temporary, purged) | Pattern only | **None**: inbound media is never stored |
| Task input and memory | `content: string` (≤ 8000), participant `CONVERSATIONAL` memory | Yes | Perception produces **text** |
| Model path (`ModelMessage`, render, estimator) | String only; no `image_url` parts | Yes | **None** in the kernel: perception is a separate call |
| Model (`R4_MODEL_*`) | `deepseek-flash`, chat completions | — | Own credentials: `R4_PERCEPTION_VISION_*`, `R4_PERCEPTION_STT_*` |
| Errors and retries | Infra failure leaves the row `received`; `resumeUnsettled` retries it | Yes | Media are processed after the ack. The perceived text is persisted before it becomes an input |
| Allowlist and hold | Decided when the binding opens; hold (kill switch, denylist, cohort, unsupported) | Yes | Download **only** when the decision is autonomous and no human owns the task |
| Injection framing | Participant text with `CONVERSATIONAL` authority; no extra wrapper | Yes | Framed text: "content of the customer, never instructions" |
| Inspector (ADR-040) | Covers text only | — | With an inspector composed, media are never perceived (held as today) |

**Kernel:** unchanged.

**Core:** changes are minimal and channel- and domain-neutral:
- the `media` variant of the contract;
- the `InboundMediaDownloader` and `MediaPerception` ports;
- the ingress;
- migration `0016`;
- the store method `recordInboundPerception`.

The Core architecture contracts (purity, channel neutrality, timers, boundaries) all pass. Everything with domain language lives in the Sales pack: the framing, the format checks, the limits, the vocabulary and the image instructions.

## 2. Speech-to-text (STT)

**Selected (owner): OpenAI `gpt-transcribe`.**
- It accepts WhatsApp's OGG/Opus as is, so no conversion and no ffmpeg on EC2. MP3, M4A and WAV also go as is.
- AAC and AMR would need conversion; for v1 they degrade to "unsupported format".
- It takes a vocabulary prompt (product names and communes).
- It can return log-probabilities, which give a per-word confidence used to mark doubtful segments.
- By default OpenAI does not train on API data. Retention runs up to 30 days for abuse monitoring, or zero on request (to be confirmed with OpenAI for this account).

**Alternative: Deepgram Nova-3 multilingual.**
- Keyterms, per-word confidence and `mip_opt_out` (the audio is not used to improve its models).
- Lower latency and price.
- It goes in through the same `SpeechTranscriber` contract: only an implementation and a configuration value change.

**Still to measure with the key:**
- whether `gpt-transcribe` returns log-probabilities;
- if it doesn't, the adapter retries without them and the transcript is marked "confidence not measured", which is never an acceptance;
- accuracy on Chilean Spanish and product names;
- latency and real cost.

## 3. Vision: decision on DeepSeek

The test was run against the real API on 2026-11-11 with the existing credentials.

| Model | `image_url` | Result |
|---|---|---|
| `deepseek-flash` | Accepted | **It sees.** It named the colour of two solid images correctly and transcribed printed text exactly («MANCUERNA HEX 12,5 KG», «SKU PC-HX-125»). About 2–4 s |
| `deepseek-v4-pro` | Accepted | **It does not see.** It silently swaps the image for `[Unsupported Image]` and keeps answering |
| both | `input_audio` 422; `file` with inline data 400 | No audio |

**Decision:** a separate perception step with `deepseek-flash`, not images inside the conversation. The reasons:
- the conversational adapter and the kernel are text-only;
- it keeps binaries out of the history and of every later context compilation;
- it produces an auditable structured representation;
- it frames the content as untrusted.

The silent degradation of `v4-pro` is guarded against: perception requires `imageVisible: true` and degrades otherwise (tested).

## 4. Media input contract

1. **Webhook.** `image` or `audio` becomes `content: { kind: 'media', mediaKind, mediaId, mimeType, sha256|null, caption|null, voice }`. A reference without a valid id or mime stays `unsupported`. Video, documents and stickers stay `unsupported`.
2. **Ingress with perception composed.** The row is recorded as `media`, holding only the reference. The webhook answers 200 (`deferred`) and the work continues right after.
3. **Binding and decision**, the same as for text:
   - **Hold** (kill switch, denylist, cohort, human-owned task): the input is today's marker `[unsupported inbound content: image]`. Nothing is downloaded.
   - **Autonomous**: the file is downloaded and perceived. The framed text is persisted on the row **before** becoming an input, and the row is then settled (its content cleared).
4. **Download** (`WhatsAppMediaDownloader`):
   - `GET /{version}/{media-id}?phone_number_id=` with the token;
   - `GET url` with the token **only** if it is https on `lookaside.fbsbx.com`;
   - no redirects;
   - the declared size is checked and the stream is cut at the byte limit;
   - one deadline;
   - the provider's SHA-256 is verified.
5. **Perception** (`SalesMediaPerceiver`):
   - real format by magic bytes, which must match the declared mime;
   - limits: image 5 MiB, audio 8 MiB and 180 s (Ogg/Opus duration from the granule);
   - 15 s for the download and 45 s for perception;
   - **any failure** becomes a "could not be processed" text, so the agent asks the customer to write it and never guesses.
6. **Text the agent sees** (only this; headers forged inside the content are neutralised):
   - `[r4:imagen]`: the customer's caption, type, description, visible text, features, catalog search hints, what can't be determined, and a warning if the image contains instructions.
   - `[r4:nota-de-voz]`: the transcript with doubtful words between ⟦…⟧.
   - `[r4:nota-de-voz-sin-confianza]`: the transcript when confidence was not measured.
   - `[r4:adjunto-no-procesado]`: the reason the file could not be processed.
7. **Acceptance** (intent guard of `@19`):
   - an image, an unprocessed file, a **forwarded** audio (`[r4:audio-reenviado]`) or a voice note without measured confidence **is never** an acceptance;
   - a voice note recorded by the customer counts only if no word is doubtful, and then it goes through the same guard as text (questions, changes, hesitation). This follows the owner's earlier decision that a customer may accept by voice;
   - the closed grammar of `@17`/`@18` never accepts a file.

## 5. Implementation and tests

| Area | Files |
|---|---|
| Core | `packages/live-ops/src/{channel,media,ingress,ports}.ts`, `packages/persistence-postgres/{migrations/0016_inbound_media.sql, src/production-store.ts}` |
| WhatsApp | `adapters/channels/whatsapp-cloud/src/{inbound,media,testing}.ts` |
| Adapters | `adapters/models/openai-compatible/src/perception.ts` (`ChatCompletionsImageDescriber`, `OpenAISpeechTranscriber`, `loadPerceptionConfig`) |
| Sales | `production/media-perception.ts` (`SalesMediaPerceiver`, framing), `capabilities/media-text.ts`, `model.ts` (`configuredMediaPerception`), `production/composition.ts`, guard in `confirmation-grammar.ts` |

**Tests:**

- **`tests/integration/inbound-media.test.ts`** (real gateway composition, fake WhatsApp, fake perception):
  - an image becomes a framed input, with metadata and file requested with the token;
  - a voice note comes out with its doubtful words marked;
  - **outside the cohort: zero downloads and zero perceptions**;
  - a resent webhook gives one download and one input;
  - a failed download degrades;
  - a model that doesn't see degrades;
  - **after a crash the stored perception is reused** and only what was pending is perceived;
  - text is unchanged;
  - with perception off, media are held exactly as before.
- **Unit tests:**
  - parser: hash in hex or base64, invalid references;
  - downloader refusals: 404, 500, outside host, redirect, declared size, real size, hash, timeout, other number;
  - format checks: sniffing, Ogg duration, mime/bytes mismatch, AAC;
  - framing: forged headers, doubt marks;
  - limits and degradations;
  - adapters: config fails closed, output validation, retry without log-probabilities;
  - guard: media acceptances.

## 6. Security assessment

- **Allowlist.** Download and perception only for autonomous work inside the allowlist (rollout 0 %). A held or human-owned conversation triggers nothing (tested).
- **Separation of permissions.**
  - WhatsApp token: downloader only.
  - Vision and STT credentials: perception only, gateway environment only (not the worker's).
  - The agent: commercial capabilities only.
  - The model never sees a credential.
- **Injection.** Perceived content is always framed as content of the customer and never instructions. Text that imitates platform headers or doubt marks is neutralised. Instructions inside an image are flagged (`containsInstructions`). Images, forwarded audio, unprocessed files and doubtful or unmeasured transcripts never count as acceptance; only a voice note the customer recorded, with every word certain, goes through the text guard. Catalog V2 is still the only source of prices and stock.
- **Download.**
  - https only, on Meta's host;
  - no redirects;
  - byte limits before and during the download;
  - integrity hash;
  - real format;
  - deadline;
  - other numbers rejected.
- **Retention.**
  - Bytes are only in memory during one perception and are never stored.
  - The reference and the perceived text stay on the row only until the input is durable, then they are cleared.
  - The input text (description or transcript) lives in the conversation memory like any customer message.
  - Telemetry `inbound.media.perceived` carries only kind, format, size, file SHA-256, duration, model, doubtful-word count, `containsInstructions` and timings. It never carries content, URLs or numbers.
- **Idempotency.** A webhook re-delivery is a duplicate (unique key on the wamid). A crash after perceiving reuses the persisted text. Within one process, the resume never takes a media item that is in flight.
- **Third parties.** DeepSeek already receives the conversation text and will now see images. OpenAI will see voice notes. Both are processed per their API policies, and retention should be confirmed for the account.

## 7. Latency and cost

| Input | Latency added | Cost per item | State |
|---|---|---|---|
| Image (1600×1200 JPEG) | ~3–4 s of perception, plus the download | ~1,300 input tokens and ~300 output tokens on `deepseek-flash` ≈ **US$0.001** at peak price | Measured (synthetic image) |
| Image with text (640×240) | ~2.3 s | ~490 input and ~300 output tokens | Measured |
| Voice note (~20 s) | To be measured (estimate 1–3 s) | ~US$0.002 at the published rate (~US$0.006/min) | **Pending the OpenAI key** |

The conversation turn grows by the length of the framed text (≈ 200–500 tokens).

## 8. Deployment, rollback and WhatsApp L3

**Before any canary:**
1. Independent review of the PR.
2. Evaluation with real services in an isolated environment:
   - the real OpenAI key (via the secrets mechanism, gateway only);
   - real WhatsApp photos and voice notes (section G of the mandate);
   - accuracy, latency and cost measured;
   - a confidence threshold calibrated (default 0.6).
3. Decide whether the agent needs its own instructions for media (a definition, and therefore `@20`). Today, `@19` handles the framed text without a change of profile. If the evaluation shows the agent misreads it, that justifies `@20`.

**Deployment** (with authorization by SHA):
1. Coordinated deploy of the SHA. Core goes `0015 → 0016`: the migration only extends a check constraint.
   - The gateway and the workers declare their compatibility with the schema head (`0016_inbound_media:<profile>`), so they are deployed together.
   - `~/r4-deploy.sh` checks head `0015` today and has to expect `0016` for this deploy.
2. `~/.config/r4/secrets/perception.env` (0600) is sourced **only** by `run-gateway.sh`, with `R4_MEDIA_PERCEPTION=enabled`, `R4_MEDIA_PERCEPTION_PROFILES` (the profiles that perceive, e.g. only the lane's; every other profile keeps holding media for a person), `R4_PERCEPTION_VISION_API_KEY` and `R4_PERCEPTION_STT_API_KEY`.
3. Restart the gateway. The lane is unchanged, the allowlist is unchanged and the rollout stays at 0 %.

**Rollback:**
- `R4_MEDIA_PERCEPTION=disabled` and restart the gateway: media are held as before.
- Unsettled media rows are processed as `unsupported`.
- Migration `0016` doesn't need to be reverted: an extra kind in the check constraint is harmless.

**WhatsApp L3 (allowlist):**
- **Audio:** a simple question; several references; a hard product name; noise; an empty clip; an ambiguous acceptance that must not issue a quote.
- **Image:** a recognisable product; a machine label; an accessory with no identification; a screenshot; text; unrelated; adversarial.
- **Infrastructure:** resent webhook, failed download, oversize file, wrong mime, timeout, restart during processing, degraded reply, allowlist isolation, text regression.

**Known limit of v1.** If a customer sends an audio and then a text right after, the text may reach the agent before the transcript, because perception takes seconds. The agent sees both in its conversation.
