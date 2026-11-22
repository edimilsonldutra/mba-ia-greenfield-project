import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { createChannel, createVideo } from '../../test/factories';
import { User } from '../../users/entities/user.entity';
import { Video, VideoFailureReason, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let repository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    repository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await createChannel(dataSource);
  });

  it('should start as a draft without processing results', async () => {
    const { id } = await createVideo(dataSource, channel);

    const video = await repository.findOneByOrFail({ id });

    expect(video).toMatchObject({
      status: VideoStatus.DRAFT,
      failure_reason: null,
      thumbnail_key: null,
      duration_seconds: null,
      metadata: null,
      processed_at: null,
    });
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
  });

  it('should refuse two videos with the same slug', async () => {
    await createVideo(dataSource, channel, { slug: 'abcdefghijk' });

    await expect(
      createVideo(dataSource, channel, { slug: 'abcdefghijk' }),
    ).rejects.toThrow(/unique/i);
  });

  it('should refuse a video without a channel', async () => {
    await expect(
      createVideo(dataSource, { id: null } as unknown as Channel),
    ).rejects.toThrow(/channel_id/);
  });

  it('should refuse a channel that does not exist', async () => {
    await expect(
      createVideo(dataSource, { id: randomUUID() } as Channel),
    ).rejects.toThrow(/foreign key/i);
  });

  it('should refuse a status outside the lifecycle', async () => {
    await expect(
      createVideo(dataSource, channel, { status: 'published' as VideoStatus }),
    ).rejects.toThrow(/enum/i);
  });

  it('should keep sizes above 32 bits as numbers', async () => {
    const tenGiB = 10 * 1024 ** 3;
    const { id } = await createVideo(dataSource, channel, {
      size_bytes: tenGiB,
    });

    expect((await repository.findOneByOrFail({ id })).size_bytes).toBe(tenGiB);
  });

  it('should hide upload_id unless explicitly selected', async () => {
    const { id } = await createVideo(dataSource, channel, {
      upload_id: 'secret-upload',
    });

    const hidden = await repository.findOneByOrFail({ id });
    const selected = await repository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where({ id })
      .getOneOrFail();

    expect(hidden.upload_id).toBeUndefined();
    expect(selected.upload_id).toBe('secret-upload');
  });

  it('should store metadata and the failure reason', async () => {
    const metadata = {
      width: 1920,
      height: 1080,
      frame_rate: 29.97,
      video_codec: 'h264',
      audio_codec: null,
      bit_rate: 800000,
      format: 'mov,mp4',
    };
    const { id } = await createVideo(dataSource, channel, {
      metadata,
      failure_reason: VideoFailureReason.INVALID_VIDEO,
      status: VideoStatus.FAILED,
    });

    expect(await repository.findOneByOrFail({ id })).toMatchObject({
      metadata,
      failure_reason: 'INVALID_VIDEO',
    });
  });

  it('should load both sides of the channel relation', async () => {
    const { id } = await createVideo(dataSource, channel);

    const video = await repository.findOneOrFail({
      where: { id },
      relations: ['channel'],
    });
    const owner = await dataSource.getRepository(Channel).findOneOrFail({
      where: { id: channel.id },
      relations: ['videos'],
    });

    expect(video.channel.nickname).toBe(channel.nickname);
    expect(owner.videos.map((v) => v.id)).toEqual([id]);
  });
});
