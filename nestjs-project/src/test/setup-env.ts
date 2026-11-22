// Runs before `dotenv/config`, which never overrides variables already set.
// Tests get their own bucket and queue prefix, so the `video-worker` container
// of the same Compose stack never consumes their jobs, and the smallest part
// size S3 accepts, so multipart uploads are exercised with small files.
process.env.S3_BUCKET = 'streamtube-test';
process.env.QUEUE_PREFIX = 'streamtube-test';
process.env.VIDEO_PART_SIZE_BYTES = String(5 * 1024 * 1024);
// Test code runs inside the Compose network, where the public host of the
// storage is not reachable.
process.env.S3_PUBLIC_ENDPOINT = 'http://minio:9000';
