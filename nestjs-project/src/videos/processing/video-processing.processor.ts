import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { VideoFailureReason } from '../entities/video.entity';
import {
  VIDEO_PROCESSING,
  type VideoProcessingJob,
} from '../queue/video-processing.constants';
import { InvalidMediaError } from './media.errors';
import { VideoProcessingService } from './video-processing.service';

/** Consumer of the processing jobs. Registered only in the video worker. */
@Processor(VIDEO_PROCESSING.QUEUE, {
  concurrency: VIDEO_PROCESSING.CONCURRENCY,
})
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<VideoProcessingJob>): Promise<void> {
    const { videoId } = job.data;
    try {
      await this.processingService.process(videoId);
      this.logger.log(`Video ${videoId} processed`);
    } catch (error) {
      if (!(error instanceof InvalidMediaError)) throw error;
      await this.processingService.fail(
        videoId,
        VideoFailureReason.INVALID_VIDEO,
      );
      throw new UnrecoverableError(error.message);
    }
  }

  /** Also emitted for stalled jobs, in which case `process` never finished. */
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJob> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const { videoId } = job.data;
    const willRetry = !job.finishedOn;
    this.logger.warn(
      `Video ${videoId} failed${willRetry ? ', will be retried' : ''}: ${error.message}`,
    );
    if (willRetry) return;

    try {
      await this.processingService.fail(
        videoId,
        VideoFailureReason.PROCESSING_ERROR,
      );
    } catch (failure) {
      // Event handler: rethrowing would crash the worker.
      this.logger.error(
        `Video ${videoId} could not be marked as failed`,
        failure,
      );
    }
  }
}
