import { ApiProperty } from '@nestjs/swagger';
import { VideoMetadataDto } from './video-metadata.dto';

export class VideoChannelDto {
  @ApiProperty({ example: 'My channel' })
  name: string;

  @ApiProperty({ example: 'my_channel' })
  nickname: string;
}

export class VideoDetailsDto {
  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ example: 'My holiday' })
  title: string;

  @ApiProperty({ example: 212.5 })
  duration_seconds: number;

  @ApiProperty({ type: VideoMetadataDto })
  metadata: VideoMetadataDto;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/stream' })
  stream_url: string;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/thumbnail' })
  thumbnail_url: string;

  @ApiProperty({ example: '/videos/dQw4w9WgXcQ/download' })
  download_url: string;

  @ApiProperty({ type: String, format: 'date-time' })
  created_at: Date;
}
