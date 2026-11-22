import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import {
  Video,
  VideoFailureReason,
  VideoStatus,
} from '../entities/video.entity';
import { VIDEO_KEYS } from '../videos.constants';
import { MediaService } from './media.service';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/** Idempotent: nothing is written unless the video is still being processed. */
@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly media: MediaService,
  ) {}

  async process(videoId: string): Promise<void> {
    const video = await this.videos.findOneBy({ id: videoId });
    if (!video || isFinished(video)) return;
    if (video.status === VideoStatus.DRAFT) {
      // The job is published before the transaction commits (TD-03).
      throw new Error(`Video ${videoId} is not being processed yet`);
    }

    const url = await this.storage.presignInternalDownload(video.storage_key);
    const { durationSeconds, metadata } = await this.media.probe(url);
    const frame = await this.media.captureFrame(url, durationSeconds);

    const thumbnailKey = VIDEO_KEYS.thumbnail(videoId);
    await this.storage.putObject(thumbnailKey, frame, THUMBNAIL_CONTENT_TYPE);

    await this.finish(videoId, {
      status: VideoStatus.READY,
      duration_seconds: durationSeconds,
      metadata,
      thumbnail_key: thumbnailKey,
    });
  }

  async fail(videoId: string, reason: VideoFailureReason): Promise<void> {
    await this.finish(videoId, {
      status: VideoStatus.FAILED,
      failure_reason: reason,
    });
  }

  private async finish(
    videoId: string,
    outcome: Partial<
      Pick<
        Video,
        | 'status'
        | 'failure_reason'
        | 'duration_seconds'
        | 'metadata'
        | 'thumbnail_key'
      >
    >,
  ): Promise<void> {
    await this.videos.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { ...outcome, processed_at: new Date() },
    );
  }
}

function isFinished({ status }: Video): boolean {
  return status === VideoStatus.READY || status === VideoStatus.FAILED;
}
