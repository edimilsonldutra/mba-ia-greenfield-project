import { ApiProperty } from '@nestjs/swagger';
import { VideoFailureReason, VideoStatus } from '../entities/video.entity';
import { VideoMetadataDto } from './video-metadata.dto';

export class VideoStatusDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ enum: VideoFailureReason, nullable: true })
  failure_reason: VideoFailureReason | null;

  @ApiProperty({ type: Number, nullable: true, example: 212.5 })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;
}
