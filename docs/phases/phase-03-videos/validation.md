---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T17:43:36-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T16:10:37-03:00"
issues:
  - id: AMB-1
    status: resolved
    summary: "Who may download: 'pelo usuário' vs. anonymous watch page (Phase 05)"
    resolved_by: phase-03-videos/TD-11
  - id: AMB-2
    status: resolved
    summary: "When a failed enqueue leaves a video in processing with no job"
    resolved_by: phase-03-videos/TD-03
  - id: MD-1
    status: resolved
    summary: "No decision for the MinIO image: the official one cannot be pulled"
    resolved_by: phase-03-videos/TD-07
  - id: DG-1
    status: resolved
    summary: "Inherited baseline does not meet the Definition of Done"
    resolved_by: phase-03-videos/SI-03.1
  - id: ICC-1
    status: resolved
    summary: "Global ThrottlerGuard would limit streaming and uploads to 10 req/min"
    resolved_by: phase-03-videos/TD-12
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **AMB-1** _(resolved_by phase-03-videos/TD-11)_ — The capability says "Download do vídeo **pelo usuário**", while the plan says anonymous users watch freely and Phase 05 puts a download button on a page with anonymous access. Choice: a `ready` video is public by URL, including download; everything else is owner-only.
- **AMB-2** _(resolved_by phase-03-videos/TD-03)_ — "Processamento automático após upload" needs a status change in PostgreSQL and a job in Redis, and no TD said what happens when only one of them succeeds. Choice: enqueue inside the database transaction, with the video id as `jobId`.
- **MD-1** _(resolved_by phase-03-videos/TD-07)_ — The storage capability assumed `minio/minio`, which can no longer be pulled from Docker Hub or Quay. Choice: `pgsty/minio`, pinned by release.
- **DG-1** _(resolved_by phase-03-videos/SI-03.1)_ — The Definition of Done of this phase requires the full suite and lint to pass, and the inherited code does not meet it: `migrations.integration-spec.ts` fails on any database that was already migrated (it drops tables but not the enum type), `npm run lint` reports 150 errors, and `.env.example` cannot be parsed by Docker Compose (`MAIL_FROM` unquoted). Choice: a first SI restricted to these three items.
- **ICC-1** _(resolved_by phase-03-videos/TD-12)_ — `phase-02-auth/TD-08` scopes rate limiting to auth endpoints, but the guard is registered as `APP_GUARD` and reaches every route. Choice: `@SkipThrottle()` on the video controllers, without changing Phase 02.
