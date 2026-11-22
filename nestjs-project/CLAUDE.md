# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio mc ready local` — expect `The cluster is ready`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`

The `video-worker` container starts with the infrastructure and waits for `npm install` before running.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — processing queue consumer (same image and code as `nestjs-api`, no port)
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `minio` — object storage, S3 API on port `9000`, console on port `9001`, user `streamtube`, password `streamtube-secret`
- `redis` — processing queue (append-only persistence), port `6379`
- `mailpit` — SMTP on port `1025`, UI on port `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker                     # Video worker (what the video-worker container runs)
npm run start:worker:prod                # Video worker from the compiled build

npm test                                 # Unit + integration tests (already --runInBand)
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (already --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`, which both scripts already pass:

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Both Jest configurations set `testTimeout` to 60 s: on a cold run over a bind mount (Windows, macOS), loading `AppModule` in the first `beforeAll` exceeds the default 5 s.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles` starts with `src/test/setup-env.ts` — it gives the tests their own bucket (`streamtube-test`) and queue prefix, so the `video-worker` container never consumes test jobs, and 5 MiB upload parts. It must come before `dotenv/config`, which does not override variables already set.
- `setupFiles` also has `"dotenv/config"` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- Two entrypoints share the code: `src/main.ts` (API, `AppModule`) and `src/worker.ts` (video worker, `WorkerModule`, no HTTP). `DatabaseModule` (`src/database/`) and `QueueModule` (`src/queue/`) hold the root connections used by both

## Videos (Phase 03)

Decisions: `docs/decisions/technical-decisions-phase-03-videos.md`. Contracts: `docs/phases/phase-03-videos/phase-03-videos.md`.

### Flow

1. `POST /videos` registers a `draft` with its unique `slug` and opens a multipart upload. **No file byte passes through the API.**
2. `POST /videos/:videoId/upload/parts` signs part URLs; the client sends each part to the storage by `PUT`. `GET /videos/:videoId/upload` lists what arrived, to resume.
3. `POST /videos/:videoId/upload/complete` verifies the parts, assembles the object and, in one transaction, moves the video to `processing` and publishes the job.
4. The worker extracts duration and metadata (`ffprobe`), stores a thumbnail (`ffmpeg`) and sets `ready` or `failed`. The owner follows it with `GET /videos/:videoId/status`.
5. `GET /videos/:slug` (details), `/stream`, `/thumbnail` and `/download` are public for `ready` videos. The last three redirect (`302`) to presigned URLs; byte ranges (`206`) are answered by the storage.

### Where things are

| Path | Responsibility |
|------|----------------|
| `src/videos/video-uploads.service.ts`, `video-uploads.controller.ts` | Upload lifecycle (draft → processing) |
| `src/videos/videos.service.ts`, `videos.controller.ts` | Status, details and delivery URLs |
| `src/videos/entities/video.entity.ts` | `videos` table; `VideoStatus`, `VideoFailureReason` |
| `src/videos/queue/` | Producer (`VideoProcessingQueue`) and queue constants |
| `src/videos/processing/` | Consumer (`VideoProcessingProcessor`), `VideoProcessingService`, `MediaService` (FFmpeg) |
| `src/storage/` | `StorageService`, the only code that talks to S3 |
| `src/config/{storage,queue,video}.config.ts` | Configuration namespaces |

### Rules

- **Never** accept a file in an API endpoint. Uploads and downloads go straight to the storage through presigned URLs.
- `StorageService` has two clients: one for calls made by the process (`S3_ENDPOINT`) and one that only signs URLs for browsers (`S3_PUBLIC_ENDPOINT`). The host is part of the signature.
- Object keys come from `VIDEO_KEYS` (`videos/{id}/source`, `videos/{id}/thumbnail.jpg`). User input is never part of a key.
- Keep `requestChecksumCalculation: 'WHEN_REQUIRED'` in the S3 clients, or a plain `PUT` to a presigned URL is refused. Do not use `paginateListParts`: it never ends against MinIO.
- The processor is registered only by `VideoProcessingModule`, imported by `WorkerModule`. Importing it in the API would make every API process consume the queue (`src/worker.module.spec.ts` guards this).
- Delivery is at-least-once: `VideoProcessingService` only writes while the video is `processing`.
- `InvalidMediaError` (the file's fault) fails the video at once; any other error is retried 3 times and then fails with `PROCESSING_ERROR`.
- FFmpeg always runs through `MediaService`, with `INPUT_RESTRICTIONS`: without the demuxer whitelist, an uploaded playlist could make it open other URLs.
- `ThrottlerGuard` is global: video controllers carry `@SkipThrottle()`.

### Testing

- Nothing of the infrastructure is mocked: tests use the PostgreSQL, MinIO, Redis and FFmpeg of Compose. Helpers live in `src/test/` (`storage.ts`, `queue.ts`, `media.ts`, `factories.ts`, `e2e-app.ts`).
- A new entity must be added to `ALL_ENTITIES` of the suites, to `cleanAllTables` and to `src/database/migrations.integration-spec.ts` (table and enum types).

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
