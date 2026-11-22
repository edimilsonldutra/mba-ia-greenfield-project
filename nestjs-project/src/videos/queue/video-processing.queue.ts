import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ProcessingUnavailableException } from '../../common/exceptions/domain.exception';
import {
  VIDEO_PROCESSING,
  type VideoProcessingJob,
} from './video-processing.constants';

/** Producer of the processing jobs. */
@Injectable()
export class VideoProcessingQueue {
  constructor(
    @InjectQueue(VIDEO_PROCESSING.QUEUE)
    private readonly queue: Queue<VideoProcessingJob>,
  ) {}

  /**
   * Publishing the same video twice keeps a single job. Without the deadline a
   * Redis outage would hold the caller (and its transaction) forever, because
   * BullMQ waits for the connection.
   */
  async publish(videoId: string): Promise<void> {
    const deadline = new AbortController();
    try {
      await Promise.race([
        this.addJob(videoId),
        this.failAfterTimeout(deadline.signal),
      ]);
    } finally {
      deadline.abort();
    }
  }

  private async addJob(videoId: string): Promise<void> {
    // A failed job is kept for inspection, and its id would silently swallow
    // the new publication.
    const previous = await this.queue.getJob(videoId);
    if (previous && (await previous.isFailed())) await previous.remove();

    await this.queue.add(
      VIDEO_PROCESSING.JOB,
      { videoId },
      {
        jobId: videoId,
        attempts: VIDEO_PROCESSING.ATTEMPTS,
        backoff: { type: 'exponential', delay: VIDEO_PROCESSING.BACKOFF_MS },
        removeOnComplete: { age: VIDEO_PROCESSING.KEEP_COMPLETED_SECONDS },
        removeOnFail: { age: VIDEO_PROCESSING.KEEP_FAILED_SECONDS },
      },
    );
  }

  private async failAfterTimeout(signal: AbortSignal): Promise<never> {
    await sleep(VIDEO_PROCESSING.PUBLISH_TIMEOUT_MS, undefined, {
      signal,
      ref: false,
    });
    throw new ProcessingUnavailableException();
  }
}
