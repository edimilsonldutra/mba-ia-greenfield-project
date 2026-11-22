---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-22
scope_description: "Backend foundation for video upload and processing: message queue, direct-to-storage upload, job consistency, worker runtime, media extraction, storage layout, unique URL, streaming, status lifecycle, and access to video files."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module, object storage integration, processing queue, video worker and the new Docker Compose services.
- `next-frontend/` — no open decision: the video UI is out of scope for this phase (challenge statement: "a interface de vídeo não faz parte do escopo desta fase"). Constraints that a browser client imposes on the API are recorded in TD-02 and TD-09.

_Not an open decision:_ the object storage technology. The project already fixes an S3-compatible storage (`docs/diagrams/software-arch.mermaid`, container "Object Storage — S3 or MinIO"). TD-06 and TD-07 decide how to use it.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". The queue carries one kind of message (process this video) at low volume, but each job is long (seconds to minutes) and must survive worker crashes, be retried with backoff and end in an inspectable failed state. The stack is NestJS 11 + PostgreSQL 17, with no Redis or broker today.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Job queue on Redis with an official NestJS integration. Retries, exponential backoff, custom job ids, stalled-job recovery through renewable locks and a failed set are built in.
- **Pros:** Official NestJS module (`@Processor`, `WorkerHost`, `@InjectQueue`). Long jobs are first class: the lock is renewed while the job runs, and a crashed worker's job returns to the queue. The custom `jobId` deduplicates repeated enqueues. Failed jobs stay inspectable.
- **Cons:** Adds Redis to the stack. At-least-once delivery, so the consumer must be idempotent. Redis needs AOF persistence so that jobs survive a restart.

### Option B: RabbitMQ (`@nestjs/microservices`)
- AMQP broker with acknowledgements, dead-letter exchanges and durable queues.
- **Pros:** Mature broker, language-agnostic, strong routing. Suits several consumers of the same event.
- **Cons:** No delayed retry or backoff out of the box (needs TTL + DLX topology). `consumer_timeout` (30 min by default) closes the channel on long unacknowledged deliveries. No job state to inspect, only messages. Routing power unused by a single consumer.

### Option C: pg-boss (PostgreSQL as the queue)
- Jobs stored in PostgreSQL, claimed with `SKIP LOCKED`.
- **Pros:** No new infrastructure. The job can be created in the same transaction as the status change, which removes the dual write.
- **Cons:** No official NestJS module. Couples queue load to the main database. The C4 diagram models the queue as a separate container, and the phase requires a queue service in Compose.

### Option D: AWS SQS (ElasticMQ locally)
- Managed queue in production, emulator in development.
- **Pros:** No broker to operate in production, native DLQ.
- **Cons:** Visibility timeout must be extended by hand for long jobs (12 h cap). No backoff per attempt. The emulator is not the production service. Ties the project to AWS, while storage was kept portable.

**Recommendation:** **Option A (BullMQ + Redis)** — the only option where the hard parts of this phase (long jobs, lock renewal, crash recovery, backoff, deduplication) are features of the tool and not code of ours, with an official module for the NestJS version in use.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.8`, `ioredis@^5.11.1`

---

## TD-02: Large File Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10 GB file must not pass through the API. `docs/project-plan.md` § 4 also requires resuming after a connection failure. S3 limits a single `PUT` to 5 GB, and a multipart upload to 10,000 parts of 5 MiB to 5 GiB each. Cross-layer because the browser talks directly to the storage.

**Options:**

### Option A: Upload through the API (multipart/form-data, streamed to storage)
- The client sends the file to NestJS, which pipes it to the storage.
- **Pros:** One endpoint, no CORS, full control of the bytes.
- **Cons:** Every byte crosses the API twice; connections stay open for the whole upload; a 10 GB upload restarts from zero on failure. It is the approach the phase forbids.

### Option B: Single presigned PUT
- The API signs one URL and the client uploads the whole file to the storage.
- **Pros:** Simplest direct upload.
- **Cons:** Capped at 5 GB by S3, so it cannot meet 10 GB. No resume.

### Option C: S3 multipart upload with presigned part URLs
- The API opens a multipart upload and signs `UploadPart` URLs on demand. The client uploads parts directly (in parallel, with per-part retry), and the API completes the upload after listing the parts in the storage.
- **Pros:** The API only handles small JSON requests. Covers 10 GB with 160 parts of 64 MiB. Resumable: uploaded parts are listed by the storage, so the client sends only the missing ones. Same API in MinIO and S3.
- **Cons:** More endpoints. Incomplete uploads occupy space until expired. The size of each part is not enforced by the signature, so the total must be verified on completion.

### Option D: tus protocol (tusd or a NestJS tus server)
- Open resumable-upload protocol with ready-made clients.
- **Pros:** Resume handled by the protocol; excellent clients (Uppy).
- **Cons:** Needs a tus server in the data path: either the API (same problem as A) or one more service, which then copies to S3.

**Recommendation:** **Option C (S3 multipart with presigned parts)** — it is the only option that meets 10 GB, resume and "API out of the data path" without a new service. The server lists the parts itself on completion, so the client never needs to read `ETag` headers (no CORS `ExposeHeaders` requirement) nor is trusted about what it sent. Part size 64 MiB, at most 100 signed URLs per request, URLs valid for 1 hour.

**Decision:** C (S3 multipart upload with presigned part URLs)

**Libraries:** `@aws-sdk/client-s3@^3.1175.0`, `@aws-sdk/s3-request-presigner@^3.1175.0`

---

## TD-03: Consistency Between Video Status and Processing Job

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Completing an upload changes the video status in PostgreSQL and publishes a job in Redis. There is no transaction across both: if one succeeds and the other fails, a video would stay `processing` forever, or a job would run for a video that is still a draft.

**Options:**

### Option A: Commit the status, then enqueue
- Update the row, commit, add the job.
- **Pros:** Simplest; the worker always sees the committed status.
- **Cons:** If Redis is down after the commit, the video is stuck in `processing` with no job and nothing retries it.

### Option B: Enqueue inside the database transaction, before commit
- Update the row, add the job (with `jobId` = video id), commit. If the enqueue fails, the transaction rolls back and the client can call the endpoint again.
- **Pros:** No stuck video: without a job there is no status change. No extra table. A repeated call is deduplicated by the `jobId`.
- **Cons:** The worker may pick up the job before the commit; it must treat "not processing yet" as a transient error. If the commit itself fails, an orphan job exists, and it must not change anything.

### Option C: Transactional outbox
- Write the event in an `outbox` table in the same transaction; a relay publishes it.
- **Pros:** Textbook guarantee, supports several events.
- **Cons:** New table, a relay process and its monitoring, for a single event type.

**Recommendation:** **Option B (enqueue inside the transaction)** — it gives the guarantee that matters (no video in `processing` without a job) with no new moving part. The two residual cases are covered by the consumer: a job for a video that is not `processing` fails and is retried with backoff, which gives the commit time to land; an orphan job exhausts its attempts without touching the row. The publication has its own deadline, because BullMQ waits indefinitely for an unreachable Redis and would hold the transaction open.

**Decision:** B (enqueue inside the database transaction)

---

## TD-04: Video Worker Runtime

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram models the Video Worker as its own container that reads the queue, updates the database and writes to the storage. FFmpeg is CPU-bound and must not compete with HTTP requests.

**Options:**

### Option A: Separate process in a separate container, same codebase
- A second entrypoint (`src/worker.ts`) boots a Nest application context with a `WorkerModule` that registers the processor. A Compose service runs it.
- **Pros:** Reuses entities, config and storage code. Scales and deploys independently. A crash in FFmpeg never affects the API.
- **Cons:** Two processes to run. The processor must be kept out of the API module graph.

### Option B: Processor inside the API process
- `@Processor` registered in `AppModule`, optionally sandboxed in a child process.
- **Pros:** Nothing new to run.
- **Cons:** Contradicts the architecture diagram, shares CPU and memory with the API, and every API replica would also process videos.

### Option C: Separate project
- A standalone worker package.
- **Pros:** Full isolation, could use another language.
- **Cons:** Duplicates entities, migrations ownership and configuration.

**Recommendation:** **Option A (separate container, same codebase)** — matches the architecture diagram and the isolation need while keeping a single source for entities and configuration.

**Decision:** A (separate process and container, same codebase)

---

## TD-05: Metadata Extraction and Thumbnail Generation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must read duration and metadata and capture a frame from files of up to 10 GB, which may be malformed or hostile (any authenticated user can upload).

**Options:**

### Option A: `ffprobe`/`ffmpeg` CLI over a presigned URL
- The worker runs the binaries with `execFile`, passing a short-lived storage URL as input. FFmpeg uses HTTP range requests to read only the headers and the region of the chosen frame.
- **Pros:** A 10 GB file is never copied to the worker's disk. No JavaScript dependency. Arguments are passed as an array, with no shell.
- **Cons:** Output parsing is ours. FFmpeg must be present in the image. Files with the index at the end cost a few extra range requests.

### Option B: `fluent-ffmpeg`
- Fluent wrapper over the same binaries.
- **Pros:** Friendlier API.
- **Cons:** Deprecated on npm ("Package no longer supported"). Adds a dependency around two commands.

### Option C: Download to a temporary file, then run FFmpeg
- Copy the object locally and process it.
- **Pros:** Works with any input; no network during processing.
- **Cons:** Up to 10 GB of disk per concurrent job and minutes of copying to read a few megabytes.

**Recommendation:** **Option A (CLI over a presigned URL)** — reading by range is what keeps the worker cheap with 10 GB files, and a deprecated wrapper is not worth it. Rules: demuxers restricted by `-format_whitelist` to MP4/QuickTime, Matroska/WebM, so that a playlist disguised as a video cannot make FFmpeg open other URLs or local files; every command has a timeout; the thumbnail is a JPEG at most 1280 px wide taken at 10% of the duration (at most 10 s in), which avoids the black first frame.

**Decision:** A (`ffprobe`/`ffmpeg` CLI over a presigned URL)

---

## TD-06: Storage Client, Bucket and Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API and the worker need an S3 client, a bucket and a key convention. Presigned URLs embed the host in the signature: the URL given to a browser must use a host the browser can reach, while containers reach the storage by its Compose service name.

**Options:**

### Option A: AWS SDK v3, one private bucket, one prefix per video, two endpoints
- `@aws-sdk/client-s3` with `forcePathStyle`. Keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`. One client for server-side calls (`S3_ENDPOINT`) and another only to sign browser-facing URLs (`S3_PUBLIC_ENDPOINT`).
- **Pros:** Same client in MinIO and S3. Everything of a video shares a prefix. Nothing is public: access always goes through a signed URL. User-supplied names never become keys.
- **Cons:** Two endpoints to configure. The SDK adds a default checksum to presigned URLs, which must be turned off (`requestChecksumCalculation: 'WHEN_REQUIRED'`).

### Option B: `minio` JavaScript client, two buckets (videos private, thumbnails public)
- MinIO's own client, with a public-read bucket for thumbnails.
- **Pros:** Thumbnail URLs are stable and cacheable.
- **Cons:** Client tied to one vendor. A public bucket exposes thumbnails of videos that are still processing. Two lifecycles to manage.

### Option C: Key by channel and original filename
- `channels/{channelId}/{filename}`.
- **Pros:** Readable bucket listing.
- **Cons:** User input in keys (collisions, encoding, path tricks). Renaming or moving a video would move objects.

**Recommendation:** **Option A (AWS SDK v3, one private bucket, prefix per video)** — portable, with no user input in keys and no public object. The bucket is created on boot when missing (`HeadBucket` first), so local environments need no manual step and production keeps the bucket provisioned by infrastructure.

**Decision:** A (AWS SDK v3, one private bucket, one prefix per video, internal and public endpoints)

**Libraries:** `@aws-sdk/client-s3@^3.1175.0`, `@aws-sdk/s3-request-presigner@^3.1175.0`

---

## TD-07: MinIO Image for the Local Environment

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The official `minio/minio` image can no longer be pulled: on 2026-11-22 Docker Hub answers "requested access to the resource is denied" for `latest` and dated tags, and `quay.io/minio/minio` has no manifest. A clean clone must still bring the storage up with `docker compose up`.

**Options:**

### Option A: `pgsty/minio` pinned by release
- Community-maintained build of MinIO, with dated release tags (latest verified: `RELEASE.2026-08-04T00-00-00Z`).
- **Pros:** Still MinIO (same binary, same configuration), still maintained, pinned tag, multi-architecture.
- **Cons:** Third-party publisher.

### Option B: `coollabsio/minio`
- Builds of the last upstream releases.
- **Pros:** Close to upstream.
- **Cons:** Last push in October 2025; no fixes since.

### Option C: Another S3-compatible server (SeaweedFS, Garage)
- Replace MinIO.
- **Pros:** Official images.
- **Cons:** Leaves the storage named by the project, with different multipart and presign edge cases.

**Recommendation:** **Option A (`pgsty/minio`, pinned)** — keeps the technology the project chose, from the only source that is both available and maintained. Production uses S3, so the image is a development concern.

**Decision:** A (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`)

---

## TD-08: Unique Video URL

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique URL (`docs/project-plan.md` § 4) that does not reveal how many videos exist.

**Options:**

### Option A: Random 11-character base64url slug with a unique constraint
- `crypto.randomBytes(8).toString('base64url')`: 64 random bits. The database enforces uniqueness and the service retries on collision.
- **Pros:** Short, URL-safe, unguessable, no dependency. The constraint makes a conflict impossible, not just improbable.
- **Cons:** Collision handling must exist, even if practically unreachable.

### Option B: UUID (the primary key)
- Use the existing id in the URL.
- **Pros:** Nothing to implement.
- **Cons:** 36 characters; not a short URL. Exposes the internal identifier.

### Option C: Encoded sequence (Sqids/Hashids)
- Encode an auto-increment number.
- **Pros:** Very short, collision-free by construction.
- **Cons:** New dependency, needs a sequence, and the encoding is reversible: it reveals volume and allows enumeration, which breaks the future "unlisted" visibility.

**Recommendation:** **Option A (random slug + unique constraint)** — short and unguessable, with the conflict ruled out by the database.

**Decision:** A (11-character random base64url slug with unique constraint)

---

## TD-09: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the file, which requires byte-range responses (`206 Partial Content`). The C4 diagram shows the frontend streaming directly from the Object Storage.

**Options:**

### Option A: API proxies byte ranges
- The API reads `Range`, fetches the slice from the storage and answers `206`.
- **Pros:** Single origin; access can be revoked at any moment.
- **Cons:** Every video byte passes through the API, the opposite of TD-02 and of the architecture diagram.

### Option B: Redirect to a presigned storage URL
- `GET /videos/{slug}/stream` answers `302` to a short-lived URL; the storage serves ranges natively. Download uses the same mechanism with `Content-Disposition: attachment`.
- **Pros:** The API only answers a small redirect. Range, `206`, `ETag` and conditional requests come from the storage. Works with `<video src>` and `curl -L`.
- **Cons:** A leaked URL is valid until it expires. The player must be able to reach the storage host.

### Option C: HLS/DASH with transcoding
- Segment and transcode the video in the worker.
- **Pros:** Adaptive bitrate; plays formats that browsers do not support.
- **Cons:** Transcoding is not among the capabilities of this phase; multiplies storage and processing.

**Recommendation:** **Option B (redirect to a presigned URL)** — keeps the API out of the data path in both directions and follows the diagram. URLs are valid for 6 hours, longer than any reasonable viewing session, because a player keeps issuing range requests against the redirected URL.

**Decision:** B (redirect to a presigned storage URL)

---

## TD-10: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The status must reflect where the video is and what happened when processing fails. Failures are of two kinds: the file is not a usable video (retrying is useless) or something around it failed (storage, network, worker crash).

**Options:**

### Option A: Four states, with failures classified by the worker
- `draft` → `processing` → `ready` | `failed`. Permanent failures (`INVALID_VIDEO`) go to `failed` at once, without retry. Transient failures are retried 3 times with exponential backoff and then go to `failed` (`PROCESSING_ERROR`). The reason is stored in `failure_reason`.
- **Pros:** Maps 1:1 to the lifecycle in the statement. The user learns the outcome quickly when the file is bad. Every path ends in a terminal state.
- **Cons:** Requires classifying errors in the worker.

### Option B: More granular states (`uploading`, `uploaded`, `extracting`, `generating_thumbnail`…)
- One state per step.
- **Pros:** Detailed progress.
- **Cons:** No capability consumes it; more transitions to keep consistent.

### Option C: Retry everything the same way
- Any error consumes the attempts.
- **Pros:** No classification.
- **Cons:** A text file renamed to `.mp4` would be retried with backoff before failing.

**Recommendation:** **Option A (four states, classified failures)** — the minimum that tells the truth to the owner. `draft` covers the upload in progress. The consumer is idempotent: thumbnails overwrite the same key, and the final update only applies while the status is `processing`. Failed jobs are kept in the queue's failed set for 7 days for inspection.

**Decision:** A (four states, classified failures)

---

## TD-11: Access to Video Resources Before Publishing Exists

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Visibility (public/unlisted) and the draft → publish flow belong to Phase 04, but this phase already exposes files. The plan states that anonymous users can watch freely and that Phase 05 places a download button on a page with anonymous access; the capability here says "pelo usuário".

**Options:**

### Option A: A `ready` video is reachable by anyone who has its URL; everything else is owner-only
- Public: details, stream, thumbnail and download of `ready` videos by slug. Owner-only: upload operations and processing status, by id. Anything the caller may not see answers `404`.
- **Pros:** Consistent with anonymous viewing (§ 1) and with the download button of Phase 05. Equivalent to "unlisted", since nothing lists videos yet, so Phase 04 only tightens it.
- **Cons:** The owner cannot hide a ready video until Phase 04.

### Option B: Streaming is public, download requires login
- Literal reading of "pelo usuário".
- **Pros:** Slightly stricter.
- **Cons:** Contradicts Phase 05. Useless as protection: whoever streams already receives the whole file.

### Option C: Everything owner-only until Phase 04
- **Pros:** Safest.
- **Cons:** Anonymous playback could not be exercised, and the streaming capability would be untestable as a viewer.

**Recommendation:** **Option A (ready videos public by URL, the rest owner-only)** — reads "usuário" as any user of the platform, as Phase 05 does. Non-owners get `404` and not `403`, so the existence of drafts is not revealed.

**Decision:** A (ready videos public by URL; upload and status owner-only)

---

## TD-12: Rate Limiting on Video Endpoints

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** `phase-02-auth/TD-08` scopes rate limiting to the auth endpoints, but `ThrottlerGuard` is registered as `APP_GUARD`, which NestJS applies to every route. Without an explicit choice, the video endpoints would inherit 10 requests per minute per IP, and a player or a 160-part upload would be blocked.

**Options:**

### Option A: `@SkipThrottle()` on the videos controller
- Opt out, as `AppController` already does.
- **Pros:** Keeps the decision of Phase 02 (auth only) true in practice. One decorator.
- **Cons:** Video endpoints have no rate limit.

### Option B: A dedicated, higher limit
- Named throttler for videos.
- **Pros:** Some protection.
- **Cons:** No requirement states a limit; the number would be invented. In-memory counters per IP punish shared networks.

### Option C: Move `ThrottlerGuard` out of `APP_GUARD`
- Apply it only to `AuthController`.
- **Pros:** Fixes the cause.
- **Cons:** Changes closed Phase 02 code and its tests; out of scope.

**Recommendation:** **Option A (`@SkipThrottle()`)** — honours the inherited decision without touching Phase 02.

**Decision:** A (`@SkipThrottle()` on the videos controller)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Cross-layer | Large File Upload Strategy | S3 multipart with presigned parts | C (S3 multipart upload with presigned part URLs) |
| TD-03 | Backend | Consistency Between Video Status and Processing Job | Enqueue inside the transaction | B (enqueue inside the database transaction) |
| TD-04 | Backend | Video Worker Runtime | Separate container, same codebase | A (separate process and container, same codebase) |
| TD-05 | Backend | Metadata Extraction and Thumbnail Generation | CLI over a presigned URL | A (`ffprobe`/`ffmpeg` CLI over a presigned URL) |
| TD-06 | Backend | Storage Client, Bucket and Key Layout | AWS SDK v3, one private bucket | A (AWS SDK v3, one private bucket, one prefix per video, internal and public endpoints) |
| TD-07 | Repo-wide | MinIO Image for the Local Environment | `pgsty/minio`, pinned | A (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`) |
| TD-08 | Backend | Unique Video URL | Random slug + unique constraint | A (11-character random base64url slug with unique constraint) |
| TD-09 | Cross-layer | Streaming and Download Delivery | Redirect to a presigned URL | B (redirect to a presigned storage URL) |
| TD-10 | Backend | Video Status Lifecycle and Failure Handling | Four states, classified failures | A (four states, classified failures) |
| TD-11 | Backend | Access to Video Resources Before Publishing Exists | Ready videos public by URL, the rest owner-only | A (ready videos public by URL; upload and status owner-only) |
| TD-12 | Backend | Rate Limiting on Video Endpoints | `@SkipThrottle()` | A (`@SkipThrottle()` on the videos controller) |
