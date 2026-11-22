export const VIDEO_PROCESSING = {
  QUEUE: 'video-processing',
  JOB: 'process-video',
  ATTEMPTS: 3,
  BACKOFF_MS: 5_000,
  CONCURRENCY: 2,
  PUBLISH_TIMEOUT_MS: 5_000,
  KEEP_COMPLETED_SECONDS: 24 * 60 * 60,
  KEEP_FAILED_SECONDS: 7 * 24 * 60 * 60,
} as const;

export interface VideoProcessingJob {
  videoId: string;
}
