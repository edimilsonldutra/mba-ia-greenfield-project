---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-21T19:20:30-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T16:10:37-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-21T19:20:30-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-21T19:20:30-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-21T19:20:29-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** video editing, categories, visibility (public/unlisted), draft → publish flow and channel panel (Fase 04); watch page, view count and suggestions (Fase 05); transcoding and adaptive streaming (no capability); deletion of videos (no capability).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — the video UI is outside this phase (challenge statement).

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto and Fase 02 — Cadastro, Login e Gerenciamento de Conta.

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta
- **Phase 04:** Gerenciamento de Vídeos e Canal

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.0.5, bullmq@^6.7.8, ioredis@^5.11.1 |
| phase-03-videos/TD-02 | phase | Cross-layer | Large File Upload Strategy | decided | C (S3 multipart upload with presigned part URLs) | @aws-sdk/client-s3@^3.1175.0, @aws-sdk/s3-request-presigner@^3.1175.0 |
| phase-03-videos/TD-03 | phase | Backend | Consistency Between Video Status and Processing Job | decided | B (enqueue inside the database transaction) | — |
| phase-03-videos/TD-04 | phase | Backend | Video Worker Runtime | decided | A (separate process and container, same codebase) | — |
| phase-03-videos/TD-05 | phase | Backend | Metadata Extraction and Thumbnail Generation | decided | A (`ffprobe`/`ffmpeg` CLI over a presigned URL) | — |
| phase-03-videos/TD-06 | phase | Backend | Storage Client, Bucket and Key Layout | decided | A (AWS SDK v3, one private bucket, one prefix per video, internal and public endpoints) | @aws-sdk/client-s3@^3.1175.0, @aws-sdk/s3-request-presigner@^3.1175.0 |
| phase-03-videos/TD-07 | phase | Repo-wide | MinIO Image for the Local Environment | decided | A (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`) | — |
| phase-03-videos/TD-08 | phase | Backend | Unique Video URL | decided | A (11-character random base64url slug with unique constraint) | — |
| phase-03-videos/TD-09 | phase | Cross-layer | Streaming and Download Delivery | decided | B (redirect to a presigned storage URL) | — |
| phase-03-videos/TD-10 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (four states, classified failures) | — |
| phase-03-videos/TD-11 | phase | Backend | Access to Video Resources Before Publishing Exists | decided | A (ready videos public by URL; upload and status owner-only) | — |
| phase-03-videos/TD-12 | phase | Backend | Rate Limiting on Video Endpoints | decided | A (`@SkipThrottle()` on the videos controller) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-06, phase-03-videos/TD-07 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-12 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-05, phase-03-videos/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-09, phase-03-videos/TD-11, phase-03-videos/TD-12 |
| Download do vídeo pelo usuário | phase-03-videos/TD-09, phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — the only option where the hard parts of this phase (long jobs, lock renewal, crash recovery, backoff, deduplication) are features of the tool and not code of ours, with an official module for the NestJS version in use.

**Libraries:** `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.8`, `ioredis@^5.11.1`

### phase-03-videos/TD-02

**Recommendation:** S3 multipart with presigned parts — it is the only option that meets 10 GB, resume and "API out of the data path" without a new service. The server lists the parts itself on completion, so the client never needs to read `ETag` headers (no CORS `ExposeHeaders` requirement) nor is trusted about what it sent. Part size 64 MiB, at most 100 signed URLs per request, URLs valid for 1 hour.

**Libraries:** `@aws-sdk/client-s3@^3.1175.0`, `@aws-sdk/s3-request-presigner@^3.1175.0`

### phase-03-videos/TD-03

**Recommendation:** Enqueue inside the transaction — it gives the guarantee that matters (no video in `processing` without a job) with no new moving part. The two residual cases are covered by the consumer: a job for a video that is not `processing` fails and is retried with backoff, which gives the commit time to land; an orphan job exhausts its attempts without touching the row. The publication has its own deadline, because BullMQ waits indefinitely for an unreachable Redis and would hold the transaction open.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Separate container, same codebase — matches the architecture diagram and the isolation need while keeping a single source for entities and configuration.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** CLI over a presigned URL — reading by range is what keeps the worker cheap with 10 GB files, and a deprecated wrapper is not worth it. Rules: demuxers restricted by `-format_whitelist` to MP4/QuickTime, Matroska/WebM, so that a playlist disguised as a video cannot make FFmpeg open other URLs or local files; every command has a timeout; the thumbnail is a JPEG at most 1280 px wide taken at 10% of the duration (at most 10 s in), which avoids the black first frame.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** AWS SDK v3, one private bucket, prefix per video — portable, with no user input in keys and no public object. The bucket is created on boot when missing (`HeadBucket` first), so local environments need no manual step and production keeps the bucket provisioned by infrastructure.

**Libraries:** `@aws-sdk/client-s3@^3.1175.0`, `@aws-sdk/s3-request-presigner@^3.1175.0`

### phase-03-videos/TD-07

**Recommendation:** `pgsty/minio`, pinned — keeps the technology the project chose, from the only source that is both available and maintained. Production uses S3, so the image is a development concern.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Random slug + unique constraint — short and unguessable, with the conflict ruled out by the database.

**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Redirect to a presigned URL — keeps the API out of the data path in both directions and follows the diagram. URLs are valid for 6 hours, longer than any reasonable viewing session, because a player keeps issuing range requests against the redirected URL.

**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** Four states, classified failures — the minimum that tells the truth to the owner. `draft` covers the upload in progress. The consumer is idempotent: thumbnails overwrite the same key, and the final update only applies while the status is `processing`. Failed jobs are kept in the queue's failed set for 7 days for inspection.

**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** Ready videos public by URL, the rest owner-only — reads "usuário" as any user of the platform, as Phase 05 does. Non-owners get `404` and not `403`, so the existence of drafts is not revealed.

**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** `@SkipThrottle()` — honours the inherited decision without touching Phase 02.

**Libraries:** —

## Inherited Decisions Detail

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Every endpoint is protected by the global `JwtAuthGuard`; public routes opt out with `@Public()`. _(from phase 02)_
- Services throw `DomainException` subclasses; `DomainExceptionFilter` answers `{ statusCode, error, message }`. _(from phase 02)_
- Global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted` and `transform`; validation errors become `VALIDATION_ERROR`. _(from phase 02)_
- `ChannelsService` owns the `Channel` entity; each user has exactly one channel. _(from phase 02)_
- Controllers carry OpenAPI decorators and reference `ApiErrorEnvelope` for errors. _(from task openapi-docs-nestjs)_
- Migrations are generated by the TypeORM CLI and exercised by `migrations.integration-spec.ts`. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | delivered later | phase-02-auth | Delivered by phase-02-auth-frontend; no effect on this phase. |

## Non-UI / Deferred Capabilities

_None._ No capability of this phase has a UI surface in scope.

## Testing Requirements

_(from `testing-guide-nestjs-project`)_

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity / migration | Integration (real PostgreSQL) |
| Service with database, storage or queue | Integration (real PostgreSQL, MinIO, Redis); unit for branch logic |
| Pure utility | Unit |
| Media extraction (FFmpeg) | Integration (real binaries over files stored in MinIO) |
| Processor | Integration (real Redis, worker in the test process); unit for failure classification |
| Controller / DTO | E2E (`supertest`) |
| Module | Unit (compiles) |
