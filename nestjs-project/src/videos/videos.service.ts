import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import type { VideoDetailsDto } from './dto/video-details.dto';
import type { VideoStatusDto } from './dto/video-status.dto';
import { Video, VideoStatus } from './entities/video.entity';

/** Reading side: the owner follows the processing, anyone watches what is ready. */
@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
  ) {}

  async getStatus(userId: string, videoId: string): Promise<VideoStatusDto> {
    const video = await this.videos.findOneBy({
      id: videoId,
      channel: { user_id: userId },
    });
    if (!video) throw new VideoNotFoundException();

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      failure_reason: video.failure_reason,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
    };
  }

  async getDetails(slug: string): Promise<VideoDetailsDto> {
    const video = await this.findReady(slug);

    return {
      slug: video.slug,
      title: video.title,
      duration_seconds: video.duration_seconds!,
      metadata: video.metadata!,
      channel: {
        name: video.channel.name,
        nickname: video.channel.nickname,
      },
      stream_url: `/videos/${video.slug}/stream`,
      thumbnail_url: `/videos/${video.slug}/thumbnail`,
      download_url: `/videos/${video.slug}/download`,
      created_at: video.created_at,
    };
  }

  async getStreamUrl(slug: string): Promise<string> {
    const video = await this.findReady(slug);
    return this.storage.presignDownload(video.storage_key);
  }

  async getThumbnailUrl(slug: string): Promise<string> {
    const video = await this.findReady(slug);
    return this.storage.presignDownload(video.thumbnail_key!);
  }

  async getDownloadUrl(slug: string): Promise<string> {
    const video = await this.findReady(slug);
    return this.storage.presignDownload(
      video.storage_key,
      video.original_filename,
    );
  }

  private async findReady(slug: string): Promise<Video> {
    const video = await this.videos.findOne({
      where: { slug, status: VideoStatus.READY },
      relations: ['channel'],
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }
}
