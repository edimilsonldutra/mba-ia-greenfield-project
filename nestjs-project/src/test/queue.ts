import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  VIDEO_PROCESSING,
  type VideoProcessingJob,
} from '../videos/queue/video-processing.constants';

/** The real queue, under the test prefix (see setup-env.ts). */
export function createTestQueue(): Queue<VideoProcessingJob> {
  const { host, port, prefix } = queueConfig();
  return new Queue<VideoProcessingJob>(VIDEO_PROCESSING.QUEUE, {
    connection: { host, port },
    prefix,
  });
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const limit = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > limit) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
