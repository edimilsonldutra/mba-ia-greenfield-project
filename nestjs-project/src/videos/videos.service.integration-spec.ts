import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import type { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createChannel, createVideo } from '../test/factories';
import { createTestStorage } from '../test/storage';
import { User } from '../users/entities/user.entity';
import {
  Video,
  VideoFailureReason,
  VideoStatus,
} from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const METADATA = {
  width: 640,
  height: 360,
  frame_rate: 30,
  video_codec: 'h264',
  audio_codec: 'aac',
  bit_rate: 1000,
  format: 'mov,mp4',
};

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let storage: StorageService;
  let service: VideosService;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    storage = await createTestStorage();
    service = new VideosService(dataSource.getRepository(Video), storage);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await createChannel(dataSource);
  });

  async function readyVideo(): Promise<Video> {
    const video = await createVideo(dataSource, channel, {
      status: VideoStatus.READY,
      duration_seconds: 3,
      metadata: METADATA,
      original_filename: 'holiday.mp4',
    });
    const thumbnail_key = `videos/${video.id}/thumbnail.jpg`;
    await dataSource.getRepository(Video).update(video.id, { thumbnail_key });
    await storage.putObject(
      video.storage_key,
      Buffer.from('0123456789'),
      'video/mp4',
    );
    await storage.putObject(thumbnail_key, Buffer.from('jpeg'), 'image/jpeg');
    return video;
  }

  describe('getStatus', () => {
    it('should tell the owner why the video failed', async () => {
      const video = await createVideo(dataSource, channel, {
        status: VideoStatus.FAILED,
        failure_reason: VideoFailureReason.INVALID_VIDEO,
      });

      expect(await service.getStatus(channel.user_id, video.id)).toEqual({
        id: video.id,
        slug: video.slug,
        status: 'failed',
        failure_reason: 'INVALID_VIDEO',
        duration_seconds: null,
        metadata: null,
      });
    });

    it('should hide the video from another user', async () => {
      const video = await createVideo(dataSource, channel);
      const other = await createChannel(dataSource);

      await expect(service.getStatus(other.user_id, video.id)).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should refuse an unknown video', async () => {
      await expect(
        service.getStatus(channel.user_id, randomUUID()),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('getDetails', () => {
    it('should return the ready video with its channel and links', async () => {
      const video = await readyVideo();

      expect(await service.getDetails(video.slug)).toEqual({
        slug: video.slug,
        title: 'A video',
        duration_seconds: 3,
        metadata: METADATA,
        channel: { name: channel.name, nickname: channel.nickname },
        stream_url: `/videos/${video.slug}/stream`,
        thumbnail_url: `/videos/${video.slug}/thumbnail`,
        download_url: `/videos/${video.slug}/download`,
        created_at: expect.any(Date),
      });
    });
  });

  describe('delivery URLs', () => {
    it('should serve ranges of the source', async () => {
      const video = await readyVideo();

      const response = await fetch(await service.getStreamUrl(video.slug), {
        headers: { Range: 'bytes=0-3' },
      });

      expect(response.status).toBe(206);
      expect(await response.text()).toBe('0123');
      expect(response.headers.get('content-disposition')).toBeNull();
    });

    it('should serve the source as an attachment', async () => {
      const video = await readyVideo();

      const response = await fetch(await service.getDownloadUrl(video.slug));

      expect(response.headers.get('content-disposition')).toContain(
        'attachment; filename="holiday.mp4"',
      );
      expect(await response.text()).toBe('0123456789');
    });

    it('should serve the thumbnail', async () => {
      const video = await readyVideo();

      const response = await fetch(await service.getThumbnailUrl(video.slug));

      expect(response.headers.get('content-type')).toBe('image/jpeg');
    });
  });

  describe.each([
    'getDetails',
    'getStreamUrl',
    'getThumbnailUrl',
    'getDownloadUrl',
  ] as const)('%s', (method) => {
    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should not reveal a %s video',
      async (status) => {
        const { slug } = await createVideo(dataSource, channel, { status });

        await expect(service[method](slug)).rejects.toThrow(
          VideoNotFoundException,
        );
      },
    );
  });
});
