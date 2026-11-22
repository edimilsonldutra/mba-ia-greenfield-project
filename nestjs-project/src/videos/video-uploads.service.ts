import { randomUUID } from 'node:crypto';
import { parse } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  InvalidPartNumberException,
  UploadAlreadyCompletedException,
  UploadIncompleteException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import type { StoredPart } from '../storage/storage.types';
import type { CreateVideoDto } from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingQueue } from './queue/video-processing.queue';
import { generateSlug } from './slug.util';
import type {
  CompletedUpload,
  SignedParts,
  StartedUpload,
  UploadProgress,
} from './video-uploads.types';
import { VIDEO_KEYS, VIDEO_LIMITS } from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';

/** Lifecycle of the upload: from the draft until the file is in the storage. */
@Injectable()
export class VideoUploadsService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly dataSource: DataSource,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(storageConfig.KEY)
    private readonly storageOptions: ConfigType<typeof storageConfig>,
    @Inject(videoConfig.KEY)
    private readonly videoOptions: ConfigType<typeof videoConfig>,
  ) {}

  async start(userId: string, dto: CreateVideoDto): Promise<StartedUpload> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();

    const id = randomUUID();
    const storageKey = VIDEO_KEYS.source(id);
    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    const video = await this.insertWithUniqueSlug({
      id,
      channel_id: channel.id,
      title: dto.title ?? defaultTitle(dto.filename),
      original_filename: dto.filename,
      content_type: dto.content_type,
      size_bytes: dto.size_bytes,
      storage_key: storageKey,
      upload_id: uploadId,
      part_size_bytes: this.videoOptions.partSizeBytes,
    });

    return {
      id,
      slug: video.slug,
      title: video.title,
      status: VideoStatus.DRAFT,
      upload: {
        part_size_bytes: video.part_size_bytes,
        part_count: partCount(video),
      },
    };
  }

  async signParts(
    userId: string,
    videoId: string,
    partNumbers: number[],
  ): Promise<SignedParts> {
    const video = await this.findDraft(userId, videoId);
    if (Math.max(...partNumbers) > partCount(video)) {
      throw new InvalidPartNumberException();
    }

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
        ),
      })),
    );
    return { expires_in: this.storageOptions.uploadUrlExpiration, parts };
  }

  async getProgress(userId: string, videoId: string): Promise<UploadProgress> {
    const video = await this.findDraft(userId, videoId);
    const stored = await this.storage.listParts(
      video.storage_key,
      video.upload_id!,
    );

    return {
      part_size_bytes: video.part_size_bytes,
      part_count: partCount(video),
      uploaded_parts: (stored ?? []).map(({ partNumber, size }) => ({
        part_number: partNumber,
        size_bytes: size,
      })),
    };
  }

  async complete(userId: string, videoId: string): Promise<CompletedUpload> {
    const video = await this.findDraft(userId, videoId);
    await this.assembleObject(video);

    // The job is published before the commit: if the queue refuses it, the
    // video is still a draft and the client can simply call again.
    await this.dataSource.transaction(async (manager) => {
      const { affected } = await manager.update(
        Video,
        { id: video.id, status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, upload_id: null },
      );
      if (!affected) throw new UploadAlreadyCompletedException();
      await this.processingQueue.publish(video.id);
    });

    return { id: video.id, slug: video.slug, status: VideoStatus.PROCESSING };
  }

  private async assembleObject(video: Video): Promise<void> {
    const parts = await this.storage.listParts(
      video.storage_key,
      video.upload_id!,
    );

    if (parts === null) {
      // A previous call assembled the object and failed before the commit.
      const size = await this.storage.getObjectSize(video.storage_key);
      if (size !== video.size_bytes) throw new UploadIncompleteException();
      return;
    }

    if (!matchesPlan(parts, video)) throw new UploadIncompleteException();
    await this.storage.completeMultipartUpload(
      video.storage_key,
      video.upload_id!,
      parts,
    );
  }

  private async findDraft(userId: string, videoId: string): Promise<Video> {
    const video = await this.videos
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .innerJoin('video.channel', 'channel')
      .where('video.id = :videoId', { videoId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();

    if (!video) throw new VideoNotFoundException();
    if (video.status !== VideoStatus.DRAFT) {
      throw new UploadAlreadyCompletedException();
    }
    return video;
  }

  private async insertWithUniqueSlug(
    data: Omit<Partial<Video>, 'slug'>,
  ): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      const video = this.videos.create({ ...data, slug: generateSlug() });
      try {
        await this.videos.insert(video);
        return video;
      } catch (error) {
        const retriable =
          isSlugCollision(error) && attempt < VIDEO_LIMITS.MAX_SLUG_ATTEMPTS;
        if (!retriable) throw error;
      }
    }
  }
}

function partCount(
  video: Pick<Video, 'size_bytes' | 'part_size_bytes'>,
): number {
  return Math.ceil(video.size_bytes / video.part_size_bytes);
}

function matchesPlan(parts: StoredPart[], video: Video): boolean {
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  return parts.length === partCount(video) && total === video.size_bytes;
}

function defaultTitle(filename: string): string {
  const name = parse(filename).name.trim() || filename;
  return name.slice(0, VIDEO_LIMITS.MAX_TITLE_LENGTH);
}

function isSlugCollision(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const { code, detail } = error as QueryFailedError & {
    code?: string;
    detail?: string;
  };
  return code === PG_UNIQUE_VIOLATION && !!detail?.includes('(slug)');
}
