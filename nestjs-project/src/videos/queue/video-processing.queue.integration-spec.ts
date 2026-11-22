import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { ProcessingUnavailableException } from '../../common/exceptions/domain.exception';
import queueConfig from '../../config/queue.config';
import { createTestQueue, waitFor } from '../../test/queue';
import {
  VIDEO_PROCESSING,
  type VideoProcessingJob,
} from './video-processing.constants';
import { VideoProcessingQueue } from './video-processing.queue';

describe('VideoProcessingQueue (integration)', () => {
  let queue: Queue<VideoProcessingJob>;
  let producer: VideoProcessingQueue;

  beforeAll(() => {
    queue = createTestQueue();
    producer = new VideoProcessingQueue(queue);
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
  });

  it('should publish the job with the video id and the retry policy', async () => {
    const videoId = randomUUID();

    await producer.publish(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toMatchObject({
      name: 'process-video',
      data: { videoId },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    });
  });

  it('should keep a single job when published twice', async () => {
    const videoId = randomUUID();

    await producer.publish(videoId);
    await producer.publish(videoId);

    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('should replace a previous failed job of the same video', async () => {
    const videoId = randomUUID();
    await queue.add(
      VIDEO_PROCESSING.JOB,
      { videoId },
      { jobId: videoId, attempts: 1 },
    );
    const { host, port, prefix } = queueConfig();
    const failing = new Worker(
      VIDEO_PROCESSING.QUEUE,
      () => Promise.reject(new Error('boom')),
      { connection: { host, port }, prefix },
    );
    await waitFor(async () => (await queue.getFailedCount()) === 1);
    await failing.close();

    await producer.publish(videoId);

    expect(await queue.getFailedCount()).toBe(0);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('should give up when Redis is unreachable instead of waiting forever', async () => {
    const { host } = queueConfig();
    const connection = new Redis({
      host,
      port: 6390,
      maxRetriesPerRequest: null,
    });
    connection.on('error', () => undefined);
    const unreachable = new Queue<VideoProcessingJob>(VIDEO_PROCESSING.QUEUE, {
      connection,
    });
    unreachable.on('error', () => undefined);

    await expect(
      new VideoProcessingQueue(unreachable).publish(randomUUID()),
    ).rejects.toThrow(ProcessingUnavailableException);

    connection.disconnect();
  }, 10_000);
});
