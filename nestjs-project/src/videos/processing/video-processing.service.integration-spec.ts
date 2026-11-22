import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import type { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { createChannel, createVideo } from '../../test/factories';
import { createMp4 } from '../../test/media';
import { createTestStorage } from '../../test/storage';
import { User } from '../../users/entities/user.entity';
import {
  Video,
  VideoFailureReason,
  VideoStatus,
} from '../entities/video.entity';
import { InvalidMediaError, MediaToolError } from './media.errors';
import { MediaService } from './media.service';
import { VideoProcessingService } from './video-processing.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideoProcessingService (integration)', () => {
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let service: VideoProcessingService;
  let channel: Channel;
  let mp4: Buffer;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videos = dataSource.getRepository(Video);
    storage = await createTestStorage();
    service = new VideoProcessingService(videos, storage, new MediaService());
    mp4 = await createMp4(3);
  }, 30_000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await createChannel(dataSource);
  });

  async function videoWith(
    content: Buffer | null,
    status = VideoStatus.PROCESSING,
  ): Promise<Video> {
    const video = await createVideo(dataSource, channel, { status });
    if (content) {
      await storage.putObject(video.storage_key, content, 'video/mp4');
    }
    return video;
  }

  const reload = (id: string) => videos.findOneByOrFail({ id });

  it('should store duration, metadata and thumbnail and become ready', async () => {
    const { id } = await videoWith(mp4);

    await service.process(id);

    const video = await reload(id);
    expect(video).toMatchObject({
      status: VideoStatus.READY,
      failure_reason: null,
      thumbnail_key: `videos/${id}/thumbnail.jpg`,
      metadata: { width: 640, height: 360, video_codec: 'h264' },
    });
    expect(video.duration_seconds).toBeCloseTo(3, 1);
    expect(video.processed_at).toBeInstanceOf(Date);
    const response = await fetch(
      await storage.presignDownload(video.thumbnail_key!),
    );
    expect(response.headers.get('content-type')).toBe('image/jpeg');
  });

  it('should be repeatable while the video is being processed', async () => {
    const { id } = await videoWith(mp4);
    await service.process(id);
    await videos.update({ id }, { status: VideoStatus.PROCESSING });

    await service.process(id);

    expect((await reload(id)).status).toBe(VideoStatus.READY);
  });

  it.each([VideoStatus.READY, VideoStatus.FAILED])(
    'should change nothing when the video is %s',
    async (status) => {
      const { id } = await videoWith(null, status);
      const before = await reload(id);

      await service.process(id);

      expect(await reload(id)).toEqual(before);
    },
  );

  it('should ignore a video that does not exist', async () => {
    await expect(service.process(randomUUID())).resolves.toBeUndefined();
  });

  it('should ask for a retry when the video is still a draft', async () => {
    const { id } = await videoWith(mp4, VideoStatus.DRAFT);

    await expect(service.process(id)).rejects.toThrow(
      'is not being processed yet',
    );
    expect((await reload(id)).status).toBe(VideoStatus.DRAFT);
  });

  it('should report an invalid file', async () => {
    const { id } = await videoWith(Buffer.from('not a video'));

    await expect(service.process(id)).rejects.toThrow(InvalidMediaError);
  });

  it('should report a missing object as transient', async () => {
    const { id } = await videoWith(null);

    await expect(service.process(id)).rejects.toThrow(MediaToolError);
  });

  describe('fail', () => {
    it('should record the reason', async () => {
      const { id } = await videoWith(null);

      await service.fail(id, VideoFailureReason.INVALID_VIDEO);

      expect(await reload(id)).toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'INVALID_VIDEO',
      });
    });

    it.each([VideoStatus.DRAFT, VideoStatus.READY])(
      'should not touch a %s video',
      async (status) => {
        const { id } = await videoWith(null, status);

        await service.fail(id, VideoFailureReason.PROCESSING_ERROR);

        expect(await reload(id)).toMatchObject({
          status,
          failure_reason: null,
        });
      },
    );
  });
});
