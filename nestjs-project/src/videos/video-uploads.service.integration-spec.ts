import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  ProcessingUnavailableException,
  UploadAlreadyCompletedException,
  UploadIncompleteException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import type { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createChannel, createVideo } from '../test/factories';
import { createTestQueue } from '../test/queue';
import {
  createTestStorage,
  MIB,
  openUploads,
  putPart,
  randomContent,
} from '../test/storage';
import { User } from '../users/entities/user.entity';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import type { VideoProcessingJob } from './queue/video-processing.constants';
import { VideoProcessingQueue } from './queue/video-processing.queue';
import * as slugUtil from './slug.util';
import { VideoUploadsService } from './video-uploads.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideoUploadsService (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let queue: Queue<VideoProcessingJob>;
  let processingQueue: VideoProcessingQueue;
  let service: VideoUploadsService;
  let channel: Channel;

  const createService = (partSizeBytes = videoConfig().partSizeBytes) =>
    new VideoUploadsService(
      videos,
      dataSource,
      new ChannelsService(dataSource),
      storage,
      processingQueue,
      storageConfig(),
      { partSizeBytes },
    );

  const dto = (overrides: Partial<CreateVideoDto> = {}): CreateVideoDto => ({
    filename: 'holiday.mp4',
    content_type: 'video/mp4',
    size_bytes: 11 * MIB, // 3 parts of 5 MiB
    ...overrides,
  });

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
    storage = await createTestStorage();
    queue = createTestQueue();
    processingQueue = new VideoProcessingQueue(queue);
    service = createService();
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    channel = await createChannel(dataSource);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('start', () => {
    it('should persist a draft owned by the channel and open the multipart upload', async () => {
      const started = await service.start(channel.user_id, dto());

      const video = await videos.findOneByOrFail({ id: started.id });
      expect(video).toMatchObject({
        channel_id: channel.id,
        slug: started.slug,
        status: VideoStatus.DRAFT,
        title: 'holiday',
        original_filename: 'holiday.mp4',
        storage_key: `videos/${started.id}/source`,
        size_bytes: 11 * MIB,
      });
      expect(await openUploads(video.storage_key)).toHaveLength(1);
    });

    it('should return the part plan', async () => {
      const started = await service.start(channel.user_id, dto());

      expect(started.upload).toEqual({
        part_size_bytes: 5 * MIB,
        part_count: 3,
      });
    });

    it('should plan 160 parts of 64 MiB for 10 GiB', async () => {
      const started = await createService(64 * MIB).start(
        channel.user_id,
        dto({ size_bytes: 10 * 1024 ** 3 }),
      );

      expect(started.upload.part_count).toBe(160);
    });

    it.each([
      [undefined, 'holiday'],
      ['My holiday', 'My holiday'],
    ])('should resolve title %p to %p', async (title, expected) => {
      const started = await service.start(channel.user_id, dto({ title }));

      expect(started.title).toBe(expected);
    });

    it('should cut a title derived from a long filename', async () => {
      const filename = `${'a'.repeat(200)}.mp4`;

      const started = await service.start(channel.user_id, dto({ filename }));

      expect(started.title).toBe('a'.repeat(100));
    });

    it('should retry with another slug on collision', async () => {
      await createVideo(dataSource, channel, { slug: 'taken-slug_' });
      jest
        .spyOn(slugUtil, 'generateSlug')
        .mockReturnValueOnce('taken-slug_')
        .mockReturnValueOnce('free--slug_');

      const started = await service.start(channel.user_id, dto());

      expect(started.slug).toBe('free--slug_');
    });

    it('should fail for a user without a channel', async () => {
      await expect(service.start(randomUUID(), dto())).rejects.toThrow(
        ChannelNotFoundException,
      );
    });
  });

  describe('signParts', () => {
    it('should return URLs that accept the parts', async () => {
      const { id } = await service.start(channel.user_id, dto());

      const signed = await service.signParts(channel.user_id, id, [1, 3]);

      expect(signed.expires_in).toBe(3600);
      expect(signed.parts.map((part) => part.part_number)).toEqual([1, 3]);
      const response = await putPart(signed.parts[0].url, randomContent(MIB));
      expect(response.status).toBe(200);
    });

    it('should refuse a part above the plan', async () => {
      const { id } = await service.start(channel.user_id, dto());

      await expect(
        service.signParts(channel.user_id, id, [1, 4]),
      ).rejects.toThrow(InvalidPartNumberException);
    });

    it('should hide the video from another user', async () => {
      const { id } = await service.start(channel.user_id, dto());
      const other = await createChannel(dataSource);

      await expect(service.signParts(other.user_id, id, [1])).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should refuse a video that is no longer a draft', async () => {
      const video = await createVideo(dataSource, channel, {
        status: VideoStatus.READY,
      });

      await expect(
        service.signParts(channel.user_id, video.id, [1]),
      ).rejects.toThrow(UploadAlreadyCompletedException);
    });
  });

  describe('complete', () => {
    const size = 6 * MIB; // parts of 5 MiB and 1 MiB

    async function upload(
      sizes: number[] = [5 * MIB, MIB],
    ): Promise<{ id: string; storage_key: string }> {
      const { id } = await service.start(
        channel.user_id,
        dto({ size_bytes: size }),
      );
      const { parts } = await service.signParts(
        channel.user_id,
        id,
        sizes.map((_, index) => index + 1),
      );
      for (const [index, part] of parts.entries()) {
        await putPart(part.url, randomContent(sizes[index]));
      }
      return { id, storage_key: `videos/${id}/source` };
    }

    const statusOf = async (id: string) =>
      (await videos.findOneByOrFail({ id })).status;

    it('should assemble the object, move to processing and publish one job', async () => {
      const { id, storage_key } = await upload();

      const completed = await service.complete(channel.user_id, id);

      expect(completed).toMatchObject({ id, status: VideoStatus.PROCESSING });
      expect(await statusOf(id)).toBe(VideoStatus.PROCESSING);
      expect(await storage.getObjectSize(storage_key)).toBe(size);
      expect((await queue.getJobs()).map((job) => job.data)).toEqual([
        { videoId: id },
      ]);
    });

    it.each([
      ['a part is missing', [5 * MIB]],
      ['the total is smaller than declared', [5 * MIB, MIB - 1]],
      ['the total is larger than declared', [5 * MIB, MIB + 1]],
    ])('should refuse when %s and keep the draft', async (_case, sizes) => {
      const { id } = await upload(sizes);

      await expect(service.complete(channel.user_id, id)).rejects.toThrow(
        UploadIncompleteException,
      );

      expect(await statusOf(id)).toBe(VideoStatus.DRAFT);
      expect(await queue.count()).toBe(0);
    });

    it('should stay a draft when the queue is unavailable and succeed on the next call', async () => {
      const { id } = await upload();
      jest
        .spyOn(processingQueue, 'publish')
        .mockRejectedValueOnce(new ProcessingUnavailableException());

      await expect(service.complete(channel.user_id, id)).rejects.toThrow(
        ProcessingUnavailableException,
      );
      expect(await statusOf(id)).toBe(VideoStatus.DRAFT);

      await service.complete(channel.user_id, id);
      expect(await statusOf(id)).toBe(VideoStatus.PROCESSING);
      expect(await queue.count()).toBe(1);
    });

    it('should refuse a second completion', async () => {
      const { id } = await upload();
      await service.complete(channel.user_id, id);

      await expect(service.complete(channel.user_id, id)).rejects.toThrow(
        UploadAlreadyCompletedException,
      );
    });

    it('should let only one of two concurrent calls win', async () => {
      const { id } = await upload();

      const results = await Promise.allSettled([
        service.complete(channel.user_id, id),
        service.complete(channel.user_id, id),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await queue.count()).toBe(1);
    });

    it('should hide the video from another user', async () => {
      const { id } = await upload();
      const other = await createChannel(dataSource);

      await expect(service.complete(other.user_id, id)).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('getProgress', () => {
    it('should list only the parts that reached the storage', async () => {
      const { id } = await service.start(channel.user_id, dto());
      const { parts } = await service.signParts(channel.user_id, id, [2]);
      await putPart(parts[0].url, randomContent(5 * MIB));

      const progress = await service.getProgress(channel.user_id, id);

      expect(progress).toEqual({
        part_size_bytes: 5 * MIB,
        part_count: 3,
        uploaded_parts: [{ part_number: 2, size_bytes: 5 * MIB }],
      });
    });

    it('should hide the video from another user', async () => {
      const { id } = await service.start(channel.user_id, dto());
      const other = await createChannel(dataSource);

      await expect(service.getProgress(other.user_id, id)).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });
});
