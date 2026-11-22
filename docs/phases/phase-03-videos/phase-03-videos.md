---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T17:43:36-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-11-22T17:43:36-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-22T17:43:36-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of files up to 10 GB sent directly to the object storage, automatic background processing (duration, metadata and thumbnail) by a separate worker, a unique URL per video, and playback and download served by the storage with byte-range support.

---

## Step Implementations

### SI-03.1 — Restore the Inherited Baseline

**Description:** Make the inherited suite, lint and environment file meet the Definition of Done before adding anything (DG-1 in `validation.md`). Restricted to the three items found, plus the Jest timeout found in the final check on a clean clone (action 5); no behavior changes.

**Technical actions:**

1. Fix `src/database/migrations.integration-spec.ts` — also drop the enum types owned by the migrations before running them, so the suite passes on a database that was already migrated
2. Update `eslint.config.mjs` — for test files only (`*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts`, `src/test/**`), turn off the `no-unsafe-*`, `unbound-method` and `require-await` rules, which conflict with Jest mocks and untyped `supertest` bodies; application code keeps every rule
3. Fix the remaining errors in code: type the PostgreSQL error in `src/channels/channels.service.ts`, the entity parameter in `src/test/create-test-data-source.ts`, and the unused variables
4. Quote `MAIL_FROM` in `.env.example`, which Docker Compose refuses to parse unquoted
5. Make the `test` and `test:e2e` scripts run in band, since the suites share one database, and set `testTimeout` to 60 s in both Jest configurations, since the first `beforeAll` of a cold run exceeds the default 5 s when `node_modules` is on a bind mount

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Migration runner | Integration: passes on an already migrated database | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm test -- --runInBand` passes twice in a row on the same database
- `npm run lint` exits with code 0
- `docker compose up -d` accepts an `.env` copied from `.env.example`

---

### SI-03.2 — Provision Storage, Queue and Media Tools

**Description:** Add the new infrastructure to Docker Compose, the libraries, and the configuration namespaces that the rest of the phase reads. No behavior yet.

**Technical actions:**

1. Install `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.8`, `ioredis@^5.11.1` (peer dependency of BullMQ 6), `@aws-sdk/client-s3@^3.1175.0` and `@aws-sdk/s3-request-presigner@^3.1175.0` (per `phase-03-videos/TD-01`, `TD-02`, `TD-06`)
2. Add `minio` (per `phase-03-videos/TD-07`) and `redis` (append-only persistence, per `phase-03-videos/TD-01`) to `compose.yaml`, with healthchecks and volumes, and make `nestjs-api` depend on them; install `ffmpeg` in `Dockerfile.dev` (per `phase-03-videos/TD-05`)
3. Create `src/config/storage.config.ts`, `src/config/queue.config.ts` and `src/config/video.config.ts` with `registerAs`, and extend `src/config/env.validation.ts` and `.env.example`; storage credentials are required
4. Create `src/test/setup-env.ts`, loaded by Jest before `dotenv/config`, so that tests use their own bucket and queue prefix and never compete with the worker container

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: storage credentials required, defaults applied | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` brings up `db`, `mailpit`, `minio`, `redis` and `nestjs-api`, all healthy or running
- Starting the application without `S3_ACCESS_KEY` fails validation at bootstrap
- `ffmpeg -version` and `ffprobe -version` run inside the `nestjs-api` container

---

### SI-03.3 — Implement the Storage Module

**Description:** Encapsulate the S3 client: bucket bootstrap, multipart lifecycle, presigned URLs and small object writes.

**Technical actions:**

1. Create `src/storage/storage.service.ts` — server-side client (`S3_ENDPOINT`) and signing client (`S3_PUBLIC_ENDPOINT`), both with `forcePathStyle` and `requestChecksumCalculation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-06`)
2. Create the bucket on module init when `HeadBucket` answers 404 (per `phase-03-videos/TD-06`)
3. Implement `createMultipartUpload`, `presignUploadPart`, `listParts` (paginated, `null` when the upload no longer exists), `completeMultipartUpload` and `getObjectSize` (per `phase-03-videos/TD-02`)
4. Implement `presignDownload` (public host, optional attachment filename), `presignInternalDownload` (worker) and `putObject` (per `phase-03-videos/TD-05`, `TD-09`)
5. Create `src/storage/storage.module.ts` exporting `StorageService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO — multipart round trip, range request answers 206, attachment header, missing upload and object | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compiles | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Parts sent with plain `PUT` to the presigned URLs, with no extra header, are listed and completed into one object of the same size
- A presigned download answers `206 Partial Content` to a `Range` request
- The bucket is created on boot when it does not exist, and boot succeeds when it already exists

---

### SI-03.4 — Create the Video Entity and Migration

**Description:** Persist videos linked to a channel, with status lifecycle, storage keys, metadata and the unique URL slug.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts` per `### Data Model`, with `VideoStatus` and `VideoFailureReason` enums, registered by a new `src/videos/videos.module.ts` (per `phase-03-videos/TD-08`, `TD-10`)
2. Add the inverse `videos` relation to `src/channels/entities/channel.entity.ts` and `ChannelsService.findByUserId`
3. Generate the migration with `npm run migration:generate -- src/database/migrations/CreateVideos` and review it
4. Register the entity and its table in the test helpers (`src/test/create-test-data-source.ts`) and in the existing suites that list entities
5. Extract the TypeORM root configuration to `src/database/database.module.ts`, to be shared by the API and the worker (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: defaults, unique slug, channel required, enum constraints, `upload_id` hidden, size above 32 bits | `src/videos/entities/video.entity.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration | `src/channels/channels.service.integration-spec.ts` |
| Migrations | Integration: apply and revert `videos` | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `npm run migration:run` creates `videos` with every column, constraint and index of the Data Model, and `migration:revert` removes it
- Two videos with the same slug are refused by the database
- A video without a channel is refused by the database

---

### SI-03.5 — Pre-register the Video as a Draft

**Description:** `POST /videos` creates the draft with its unique URL and opens the multipart upload, without receiving any byte of the file.

**Technical actions:**

1. Create `src/videos/slug.util.ts` — `generateSlug()` (per `phase-03-videos/TD-08`)
2. Create `src/videos/dto/create-video.dto.ts` and `src/videos/videos.constants.ts` — accepted types, 10 GiB limit, part limits
3. Create `src/videos/video-uploads.service.ts` with `start` — channel lookup, slug retry on unique violation, multipart creation, part plan (per `phase-03-videos/TD-02`, `TD-10`)
4. Create `src/videos/video-uploads.controller.ts` with `POST /videos`, `@SkipThrottle()` (per `phase-03-videos/TD-12`) and OpenAPI decorators; add the domain exceptions of `### Error Catalog`
5. Register the controller and the service in `src/videos/videos.module.ts`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateSlug` | Unit: alphabet, length, no repetition | `src/videos/slug.util.spec.ts` |
| `VideoUploadsService.start` | Integration: draft persisted, part plan, slug collision retried | `src/videos/video-uploads.service.integration-spec.ts` |
| `POST /videos` | E2E: 201, 400, 401, not throttled | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4

**Acceptance criteria:**

- `POST /videos` with a valid body returns `201` with a `draft` video, its slug and the part plan, and an open multipart upload exists in the storage
- A declared size of exactly 10 GiB is accepted with 160 parts; one byte more returns `400 VALIDATION_ERROR`
- A content type outside the accepted list returns `400 VALIDATION_ERROR`
- A slug collision is resolved without an error to the client

---

### SI-03.6 — Sign Parts and Resume the Upload

**Description:** Let the owner obtain presigned part URLs on demand and discover which parts already reached the storage.

**Technical actions:**

1. Implement `VideoUploadsService.signParts` — owner and `draft` check, range check against the part plan (per `phase-03-videos/TD-02`)
2. Implement `VideoUploadsService.getProgress` — parts listed from the storage (per `phase-03-videos/TD-02`)
3. Create `src/videos/dto/sign-upload-parts.dto.ts` and the endpoints `POST /videos/:videoId/upload/parts` and `GET /videos/:videoId/upload`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService` | Integration: signed URLs accept data, progress lists only what arrived, foreign video hidden | `src/videos/video-uploads.service.integration-spec.ts` |
| Upload endpoints | E2E: 200, 400, 401, 404 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- The returned URLs accept the parts by plain `PUT`
- After sending part 2 of 3, `GET /videos/:videoId/upload` lists only part 2
- Another user receives `404 VIDEO_NOT_FOUND`
- A part number above the plan returns `400 INVALID_PART_NUMBER`

---

### SI-03.7 — Complete the Upload and Publish the Job

**Description:** Verify and assemble the parts, move the video to `processing` and publish the processing job atomically with the status change.

**Technical actions:**

1. Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` with the connection and prefix of `queue.config.ts` (per `phase-03-videos/TD-01`)
2. Create `src/videos/queue/video-processing.queue.ts` — publishes `process-video` with `jobId` = video id, 3 attempts, exponential backoff, replaces a previous failed job of the same video, and gives up after 5 s when Redis is unreachable (per `phase-03-videos/TD-01`, `TD-03`)
3. Implement `VideoUploadsService.complete` — list parts, verify count and total size, complete the multipart, tolerate a multipart already completed, and enqueue inside the transaction (per `phase-03-videos/TD-02`, `TD-03`)
4. Add `POST /videos/:videoId/upload/complete`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueue` | Integration: real Redis — options, deduplication, failed job replaced | `src/videos/queue/video-processing.queue.integration-spec.ts` |
| `VideoUploadsService.complete` | Integration: status and job, incomplete upload, enqueue failure rolls back and can be retried | `src/videos/video-uploads.service.integration-spec.ts` |
| Complete endpoint | E2E: 202, 404, 409 | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6

**Acceptance criteria:**

- Completing with every part returns `202`, the status becomes `processing` and one job exists for the video
- Completing with a missing part, or with a total size different from the declared one, returns `409 UPLOAD_INCOMPLETE` and the video stays `draft`
- When the queue is unavailable the endpoint returns `503 PROCESSING_UNAVAILABLE`, the video stays `draft`, and a later call succeeds although the multipart was already assembled
- Completing twice returns `409 UPLOAD_ALREADY_COMPLETED`

---

### SI-03.8 — Extract Metadata and Capture a Frame

**Description:** Wrap `ffprobe` and `ffmpeg` behind a service that reads a URL and either returns data or classifies the failure.

**Technical actions:**

1. Create `src/videos/processing/media.errors.ts` — `InvalidMediaError` (permanent) and `MediaToolError` (transient) (per `phase-03-videos/TD-10`)
2. Create `src/videos/processing/media.service.ts` with `probe(url)` — JSON output, demuxer whitelist, timeout, duration and metadata mapping, cover art ignored (per `phase-03-videos/TD-05`)
3. Implement `captureFrame(url, duration)` — JPEG through `stdout`, at most 1280 px wide, 10% of the duration up to 10 s (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaService` | Integration: real FFmpeg over files stored in MinIO — MP4, WebM, text renamed to MP4, truncated MP4, audio only, playlists disguised as video, unreachable host | `src/videos/processing/media.service.integration-spec.ts` |
| Error classification | Unit | `src/videos/processing/media.service.spec.ts` |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- A generated 3 s MP4 yields its duration, dimensions, codecs and frame rate
- The captured frame is a JPEG
- A file that is not a video, an audio file and a playlist are refused as invalid, and no URL inside the playlist is requested
- An unreachable host is reported as transient

---

### SI-03.9 — Run the Video Worker

**Description:** Consume the queue in a separate process, update the video and end every path in a terminal status.

**Technical actions:**

1. Create `src/videos/processing/video-processing.service.ts` — `process(videoId)` and `fail(videoId, reason)`, both conditional on `status = 'processing'` (per `phase-03-videos/TD-10`)
2. Create `src/videos/processing/video-processing.processor.ts` — permanent errors become `UnrecoverableError`; the `failed` event marks the video only on the final failure (per `phase-03-videos/TD-01`, `TD-10`)
3. Create `src/videos/processing/video-processing.module.ts`, `src/worker.module.ts` and `src/worker.ts`, with graceful shutdown (per `phase-03-videos/TD-04`)
4. Add the `video-worker` service to `compose.yaml` and the `start:worker` scripts to `package.json` (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Integration: real PostgreSQL, MinIO and FFmpeg | `src/videos/processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingProcessor` | Integration: real Redis — success, invalid file without retry, transient failure retried until `failed` | `src/videos/processing/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Unit: compiles and does not register HTTP controllers | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.7, SI-03.8

**Acceptance criteria:**

- A completed upload becomes `ready` with duration, metadata and a thumbnail stored
- An invalid file becomes `failed` with `INVALID_VIDEO` on the first attempt
- A transient failure is retried 3 times and then becomes `failed` with `PROCESSING_ERROR`
- Processing a video that is already `ready` changes nothing
- `docker compose up -d` starts the worker container, and the API process registers no processor

---

### SI-03.10 — Serve Status, Details, Stream, Thumbnail and Download

**Description:** Expose the processing status to the owner and the ready video to anyone with its URL, with the bytes served by the storage.

**Technical actions:**

1. Create `src/videos/videos.service.ts` — `getStatus` (owner), `getReadyBySlug` and the delivery URLs (per `phase-03-videos/TD-09`, `TD-11`)
2. Create the response DTOs `src/videos/dto/video-status.dto.ts` and `src/videos/dto/video-details.dto.ts`
3. Create `src/videos/videos.controller.ts` with `GET /videos/:videoId/status`, `GET /videos/:slug`, `/stream`, `/thumbnail` and `/download`, `@SkipThrottle()` and OpenAPI decorators (per `phase-03-videos/TD-12`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Integration: ready only, owner only, delivery URLs | `src/videos/videos.service.integration-spec.ts` |
| Read endpoints | E2E: anonymous access, 206 after the redirect, attachment, 404 for drafts and foreign videos | `test/videos.e2e-spec.ts` |
| OpenAPI | Integration: every video endpoint documented | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `GET /videos/:slug/stream` redirects anonymously to a URL that answers `206` to a `Range` request
- `GET /videos/:slug/download` redirects to a URL that answers `Content-Disposition: attachment` with the original filename
- A video that is not `ready` answers `404` on every public route
- The status of a video is visible to its owner only

---

### SI-03.11 — Prove the Full Flow and Update the Documentation

**Description:** Exercise upload, processing and playback end to end with the real infrastructure, and make the documentation match the code.

**Technical actions:**

1. Create the full-flow E2E — register, login, draft, multipart upload in several parts, worker processing, stream with range and download
2. Update `nestjs-project/CLAUDE.md` and the root `CLAUDE.md` with the videos module, endpoints, queue, worker and storage
3. Update `README.md` and replace "TBD" by the chosen queue in `docs/diagrams/software-arch.mermaid`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Full flow | E2E | `test/videos-flow.e2e-spec.ts` |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- The flow ends with a `ready` video whose stream and download return the bytes that were uploaded
- Every file, endpoint and command cited in the documentation exists

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Also the queue `jobId` and the storage prefix |
| channel_id | uuid | FK → channels.id, not null | Owner |
| slug | varchar(11) | unique, not null | Public URL identifier (TD-08) |
| title | varchar(100) | not null | Defaults to the filename without extension |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | TD-10 |
| failure_reason | enum | nullable, values: `'INVALID_VIDEO'`, `'PROCESSING_ERROR'` | Set only with `failed` |
| original_filename | varchar(255) | not null | Used as the download name; never as a key |
| content_type | varchar(100) | not null | |
| size_bytes | bigint | not null | Declared size, verified on completion; mapped to `number` |
| storage_key | varchar(255) | not null | `videos/{id}/source` |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg` |
| upload_id | varchar | nullable, `select: false` | Multipart upload id; cleared on completion |
| part_size_bytes | integer | not null | Part plan fixed at creation |
| duration_seconds | double precision | nullable | |
| metadata | jsonb | nullable | `{ width, height, frame_rate, video_codec, audio_codec, bit_rate, format }` |
| processed_at | timestamp | nullable | |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many)
**Indexes:** `(slug)` — unique, `(channel_id)` — FK

**Status transitions:**

| From | To | When | By |
|------|----|------|----|
| — | `draft` | `POST /videos` | API |
| `draft` | `processing` | Upload completed and job published | API |
| `processing` | `ready` | Metadata and thumbnail stored | Worker |
| `processing` | `failed` | Invalid file, or transient failure after the last attempt | Worker |

---

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 to 255 characters
- content_type: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`
- size_bytes: integer, required — 1 to 10737418240 (10 GiB)
- title: string, optional — 1 to 100 characters

**Response 201:**
- id: string (uuid)
- slug: string (11 characters)
- title: string
- status: `"draft"`
- upload: `{ part_size_bytes: number, part_count: number }`

**Error responses:**
- 400 VALIDATION_ERROR: when the body fails validation
- 401: when the access token is missing or invalid
- 404 CHANNEL_NOT_FOUND: when the user has no channel

---

#### POST /videos/:videoId/upload/parts (SI-03.6)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 to 100 unique items, each ≥ 1

**Response 200:**
- expires_in: number (seconds)
- parts: `{ part_number: number, url: string }[]` — each URL accepts one `PUT` with the bytes of the part

**Error responses:**
- 400 VALIDATION_ERROR: when the body or the id is invalid
- 400 INVALID_PART_NUMBER: when a part number is above the part plan
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another user
- 409 UPLOAD_ALREADY_COMPLETED: when the video is no longer a draft

---

#### GET /videos/:videoId/upload (SI-03.6)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- part_size_bytes: number
- part_count: number
- uploaded_parts: `{ part_number: number, size_bytes: number }[]`

**Error responses:**
- 400 VALIDATION_ERROR: when the id is not a UUID
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another user
- 409 UPLOAD_ALREADY_COMPLETED: when the video is no longer a draft

---

#### POST /videos/:videoId/upload/complete (SI-03.7)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 202:**
- id: string (uuid)
- slug: string
- status: `"processing"`

**Error responses:**
- 400 VALIDATION_ERROR: when the id is not a UUID
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another user
- 409 UPLOAD_INCOMPLETE: when a part is missing or the total size differs from the declared one
- 409 UPLOAD_ALREADY_COMPLETED: when the video is no longer a draft
- 503 PROCESSING_UNAVAILABLE: when the job cannot be published; the call can be repeated

---

#### GET /videos/:videoId/status (SI-03.10)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- slug: string
- status: `"draft" | "processing" | "ready" | "failed"`
- failure_reason: `"INVALID_VIDEO" | "PROCESSING_ERROR" | null`
- duration_seconds: number | null
- metadata: object | null

**Error responses:**
- 400 VALIDATION_ERROR: when the id is not a UUID
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or belongs to another user

---

#### GET /videos/:slug (SI-03.10)

**Response 200:**
- slug: string
- title: string
- duration_seconds: number
- metadata: object
- channel: `{ name: string, nickname: string }`
- stream_url, thumbnail_url, download_url: string — paths of the endpoints below
- created_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when there is no `ready` video with the slug

---

#### GET /videos/:slug/stream (SI-03.10)

**Response 302:** `Location` is a presigned storage URL that supports `Range` (the storage answers `206`). `Cache-Control: no-store`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when there is no `ready` video with the slug

---

#### GET /videos/:slug/thumbnail (SI-03.10)

**Response 302:** `Location` is a presigned storage URL of the JPEG thumbnail. `Cache-Control: no-store`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when there is no `ready` video with the slug

---

#### GET /videos/:slug/download (SI-03.10)

**Response 302:** `Location` is a presigned storage URL that answers `Content-Disposition: attachment` with the original filename. `Cache-Control: no-store`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when there is no `ready` video with the slug

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ (401) | ✓ | ✓ |
| POST /videos/:videoId/upload/parts | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:videoId/upload | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:videoId/upload/complete | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:videoId/status | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:slug | ✓ (ready only) | ✓ (ready only) | ✓ (ready only) |
| GET /videos/:slug/stream | ✓ (ready only) | ✓ (ready only) | ✓ (ready only) |
| GET /videos/:slug/thumbnail | ✓ (ready only) | ✓ (ready only) | ✓ (ready only) |
| GET /videos/:slug/download | ✓ (ready only) | ✓ (ready only) | ✓ (ready only) |

---

### Error Catalog

Error response format inherited from Phase 02: `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found | POST /videos by a user without a channel |
| VIDEO_NOT_FOUND | 404 | Video not found | Unknown video, video of another user, or public route of a video that is not `ready` |
| INVALID_PART_NUMBER | 400 | Part number is outside the upload plan | POST /videos/:videoId/upload/parts above `part_count` |
| UPLOAD_INCOMPLETE | 409 | Upload is incomplete or does not match the declared size | POST /videos/:videoId/upload/complete with missing parts or different size |
| UPLOAD_ALREADY_COMPLETED | 409 | Upload was already completed | Upload operation on a video that is not `draft` |
| PROCESSING_UNAVAILABLE | 503 | Video processing is unavailable, try again later | POST /videos/:videoId/upload/complete when the queue does not accept the job within 5 s |

Failure reasons stored in `videos.failure_reason` (not HTTP errors):

| Reason | Meaning | Retried |
|--------|---------|---------|
| INVALID_VIDEO | The file is not a supported video, has no video stream or no duration, or cannot be decoded | No |
| PROCESSING_ERROR | Storage, network, timeout or worker failure that persisted through every attempt | 3 attempts |

---

### Events/Messages

#### process-video

Queue: `video-processing` (BullMQ, key prefix from `QUEUE_PREFIX`).

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingQueue`, called by `VideoUploadsService.complete` (per `phase-03-videos/TD-03`)
**Consumer:** `VideoProcessingProcessor`, in the `video-worker` container (per `phase-03-videos/TD-04`)
**Trigger:** the multipart upload was assembled and the video moved from `draft` to `processing`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`). The consumer is idempotent: it only writes while the video is `processing`, and the thumbnail overwrites the same key

| Option | Value |
|--------|-------|
| `jobId` | video id — repeated publication is ignored; a previous *failed* job of the same video is removed first |
| `attempts` | 3 |
| `backoff` | exponential, 5 s (5 s, 10 s) |
| `removeOnComplete` | after 1 day |
| `removeOnFail` | after 7 days (the failed set is the dead-letter queue) |
| Worker `concurrency` | 2 |

**Outcomes:**

| Situation | Job | Video |
|-----------|-----|-------|
| Success | completed | `ready` |
| Invalid file | failed at once (`UnrecoverableError`) | `failed` / `INVALID_VIDEO` |
| Transient error, attempts left | delayed, retried | `processing` |
| Transient error, last attempt | failed | `failed` / `PROCESSING_ERROR` |
| Worker crash | lock expires, job returns to the queue (once) | `processing` |
| Video not `processing` yet (job seen before the commit) | delayed, retried | unchanged |
| Video already `ready`, `failed` or deleted | completed without effect | unchanged |

---

## Dependency Map

```
SI-03.1 (root)
└── SI-03.2 — needs a green baseline
    ├── SI-03.3 — needs storage and config
    │   └── SI-03.8 — needs storage to serve files to FFmpeg
    └── SI-03.4 — needs the configuration and Compose services

SI-03.3 + SI-03.4
└── SI-03.5 — needs storage and entity
    └── SI-03.6 — needs the draft
        └── SI-03.7 — needs the signed parts

SI-03.7 + SI-03.8
└── SI-03.9 — needs the job and the media service
    └── SI-03.10 — needs ready videos
        └── SI-03.11 — needs the complete feature
```

Linearized implementation order: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11

## Deliverables

- [x] SI-03.1 — Inherited baseline restored (suite, lint, `.env.example`)
- [x] SI-03.2 — MinIO, Redis and FFmpeg available in Docker Compose, with validated configuration
- [x] SI-03.3 — Storage module over S3 (multipart, presigned URLs, bucket bootstrap)
- [x] SI-03.4 — `videos` table and entity linked to the channel
- [x] SI-03.5 — Draft pre-registration with unique URL
- [x] SI-03.6 — Presigned parts and resumable upload
- [x] SI-03.7 — Upload completion with atomic job publication
- [x] SI-03.8 — Metadata extraction and frame capture with classified failures
- [x] SI-03.9 — Video worker in its own container
- [x] SI-03.10 — Status, details, streaming, thumbnail and download
- [x] SI-03.11 — Full flow proven and documentation updated
- [x] Upload of a 10 GB file exercised against the running stack
- [x] All tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [x] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [x] Type check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [x] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [x] Project builds successfully (`docker compose exec nestjs-api npm run build`)
