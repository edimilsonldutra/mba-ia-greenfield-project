---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/websites/nestjs"
    fetched_at: "2026-11-22T15:19:22-03:00"
  bullmq:
    version: "^6.7.8"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-22T15:19:22-03:00"
  ioredis:
    version: "^5.11.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-22T15:19:22-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1175.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-22T15:19:22-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1175.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-22T15:19:22-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T16:10:37-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase, pulled from Context7 through its HTTP API (`https://context7.com/api/v2/context`). Each section separates what the documentation says from what was observed with the installed version.

## @nestjs/bullmq

**Source:** `/websites/nestjs` (Context7), page "Queues" (v11). Maps to `phase-03-videos/TD-01`.

`@nestjs/bullmq` 12 targets NestJS 12. Version 11.0.5 is the one whose peer dependencies accept NestJS 11 **and** BullMQ 6.

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: { host: config.host, port: config.port },
    prefix: config.prefix,
  }),
});
BullModule.registerQueue({ name: 'video-processing' });

@Processor('video-processing', { concurrency: 2 })
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job): Promise<void> {}

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {}
}
```

- Worker events must be declared inside the class decorated with `@Processor()`.

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7) — guides "Retrying failing jobs", "Job ids", "Throttle jobs" and `worker-options.ts`. Maps to `phase-03-videos/TD-01`, `TD-03`, `TD-10`.

- `attempts: 3` with `backoff: { type: 'exponential', delay }` waits `2^(attempt - 1) * delay`.
- A custom `jobId` must be unique in the queue, otherwise the job is **ignored**. Avoid `:` and digit-only ids. A job that is still in the queue — including the failed set — counts as existing; one that was removed does not.
- `UnrecoverableError` skips the remaining attempts.
- `lockDuration` defaults to 30 s and is renewed automatically; `maxStalledCount` defaults to 1: a job whose worker died returns to the queue once, and the next time goes to `failed`.
- A failure is final only when no retry is left; the `failed` event fires for every attempt.

**Observed with 6.7.8:**

- `ioredis` is an **optional peer dependency** in BullMQ 6: without installing it, `new Queue()` throws.
- With Redis unreachable, `queue.add()` **never settles**, even with `enableOfflineQueue: false` and `maxRetriesPerRequest: 1`. The producer needs its own deadline (`VideoProcessingQueue.publish`).
- `job.finishedOn` is only set when the job reaches a final state, which is how the `failed` listener tells a final failure from a retry.

## ioredis

**Source:** peer dependency of BullMQ, documented in `/taskforcesh/bullmq`. Kept on `^5`, the major version supported by BullMQ 6.

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7) — `UploadPartCommand`, `ListPartsCommand`, `CompleteMultipartUploadCommand`, `CLIENTS.md`, flexible checksums. Maps to `phase-03-videos/TD-02`, `TD-06`.

- `forcePathStyle: true` is required for endpoints without bucket subdomains (MinIO).
- `requestChecksumCalculation` defaults to `WHEN_SUPPORTED`, which adds a CRC32 to `UploadPart`; with `WHEN_REQUIRED` no checksum is calculated or signed for operations that do not require it.

**Observed with 3.1175.0 and MinIO:**

- `paginateListParts` **loops forever** against MinIO, which returns `NextPartNumberMarker` on the last page too. `StorageService.listParts` pages by `IsTruncated`.
- Missing things arrive as typed errors: `NoSuchUpload` (`ListParts` after completion) and `NotFound` (`HeadBucket`, `HeadObject`).

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7) — `packages/s3-request-presigner`. Maps to `phase-03-videos/TD-02`, `TD-09`.

- `getSignedUrl(client, command, { expiresIn })` signs the **host** of the client's endpoint: a URL for browsers must be signed by a client configured with the public endpoint.
- The presigner forces `UNSIGNED-PAYLOAD` and excludes `content-type` from the signature. The size of a part is therefore not enforced by the URL; `VideoUploadsService.complete` verifies the total.
