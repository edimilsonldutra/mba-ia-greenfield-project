import { ApiProperty } from '@nestjs/swagger';
import type { VideoMetadata } from '../videos.types';

export class VideoMetadataDto implements VideoMetadata {
  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ type: Number, nullable: true, example: 29.97 })
  frame_rate: number | null;

  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 800000 })
  bit_rate: number | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format: string;
}
