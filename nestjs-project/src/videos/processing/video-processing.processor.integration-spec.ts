import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { StorageService } from '../../storage/storage.service';
import { cleanAllTables } from '../../test/create-test-data-source';
import { createChannel, createVideo } from '../../test/factories';
import { createMp4 } from '../../test/media';
import { createTestQueue, waitFor } from '../../test/queue';
import { WorkerModule } from '../../worker.module';
import { Video, VideoStatus } from '../entities/video.entity';
import {
  VIDEO_PROCESSING,
  type VideoProcessingJob,
} from '../queue/video-processing.constants';
import { MediaToolError } from './media.errors';
import { MediaService } from './media.service';

describe('VideoProcessingProcessor (integration)', () => {
  let worker: INestApplicationContext;
  let queue: Queue<VideoProcessingJob>;
  let videos: Repository<Video>;
  let storage: StorageService;
  let channel: Channel;
  let mp4: Buffer;

  beforeAll(async () => {
    queue = createTestQueue();
    await queue.obliterate({ force: true });
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    worker = await module.init();
    videos = worker.get(DataSource).getRepository(Video);
    storage = worker.get(StorageService, { strict: false });
    mp4 = await createMp4(1);
  }, 30_000);

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
  });

  beforeEach(async () => {
    await cleanAllTables(worker.get(DataSource));
    channel = await createChannel(worker.get(DataSource));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function submit(
    content: Buffer,
    status = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const video = await createVideo(worker.get(DataSource), channel, {
      status,
    });
    await storage.putObject(video.storage_key, content, 'video/mp4');
    await queue.add(
      VIDEO_PROCESSING.JOB,
      { videoId: video.id },
      {
        jobId: video.id,
        attempts: VIDEO_PROCESSING.ATTEMPTS,
        backoff: { type: 'fixed', delay: 100 },
      },
    );
    return video;
  }

  const waitForStatus = (id: string, status: VideoStatus) =>
    waitFor(
      async () => (await videos.findOneByOrFail({ id })).status === status,
    );

  const waitForJob = (id: string) =>
    waitFor(async () => !!(await queue.getJob(id))?.finishedOn);

  it('should make the video ready', async () => {
    const { id } = await submit(mp4);

    await waitForStatus(id, VideoStatus.READY);
  });

  it('should fail an invalid file at once, without retrying', async () => {
    const { id } = await submit(Buffer.from('not a video'));

    await waitForStatus(id, VideoStatus.FAILED);
    await waitForJob(id);

    const video = await videos.findOneByOrFail({ id });
    const job = await queue.getJob(id);
    expect(video.failure_reason).toBe('INVALID_VIDEO');
    expect(job!.attemptsMade).toBe(1);
  });

  it('should retry a transient failure and then fail the video', async () => {
    const probe = jest
      .spyOn(worker.get(MediaService, { strict: false }), 'probe')
      .mockRejectedValue(new MediaToolError('storage is down'));
    const { id } = await submit(mp4);

    await waitForStatus(id, VideoStatus.FAILED);

    const video = await videos.findOneByOrFail({ id });
    expect(video.failure_reason).toBe('PROCESSING_ERROR');
    expect(probe).toHaveBeenCalledTimes(VIDEO_PROCESSING.ATTEMPTS);
  });

  it('should recover when the failure goes away before the last attempt', async () => {
    jest
      .spyOn(worker.get(MediaService, { strict: false }), 'probe')
      .mockRejectedValueOnce(new MediaToolError('storage is down'));
    const { id } = await submit(mp4);

    await waitForStatus(id, VideoStatus.READY);
  });

  it('should wait for the transaction that published the job', async () => {
    const { id } = await submit(mp4, VideoStatus.DRAFT);
    await waitFor(async () => (await queue.getJob(id))!.attemptsMade >= 1);

    await videos.update({ id }, { status: VideoStatus.PROCESSING });

    await waitForStatus(id, VideoStatus.READY);
  });

  it('should not touch a draft whose transaction never committed', async () => {
    const { id } = await submit(mp4, VideoStatus.DRAFT);

    await waitForJob(id);

    expect(await videos.findOneByOrFail({ id })).toMatchObject({
      status: VideoStatus.DRAFT,
      failure_reason: null,
    });
  });
});
