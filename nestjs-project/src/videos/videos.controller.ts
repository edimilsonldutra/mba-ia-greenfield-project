import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { VideoDetailsDto } from './dto/video-details.dto';
import { VideoStatusDto } from './dto/video-status.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Get(':videoId/status')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get processing status',
    description:
      'Tells the owner where the video is in its lifecycle and, when it failed, why.',
  })
  @ApiResponse({
    status: 200,
    description: 'Processing status',
    type: VideoStatusDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid video id',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found or owned by another user',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getStatus(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
  ): Promise<VideoStatusDto> {
    return this.videosService.getStatus(user.sub, videoId);
  }

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Get a video',
    description: 'Details of a ready video, for anyone who has its URL.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video details',
    type: VideoDetailsDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No ready video with this slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getDetails(@Param('slug') slug: string): Promise<VideoDetailsDto> {
    return this.videosService.getDetails(slug);
  }

  @Public()
  @Get(':slug/stream')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a temporary storage URL that answers byte ranges (206 Partial Content), so playback starts without downloading the file.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage' })
  @ApiResponse({
    status: 404,
    description: 'No ready video with this slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getStreamUrl(slug) };
  }

  @Public()
  @Get(':slug/thumbnail')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Get the thumbnail',
    description: 'Redirects to a temporary storage URL of the JPEG thumbnail.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage' })
  @ApiResponse({
    status: 404,
    description: 'No ready video with this slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async thumbnail(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getThumbnailUrl(slug) };
  }

  @Public()
  @Get(':slug/download')
  @Redirect()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a temporary storage URL that answers as an attachment with the original filename.',
  })
  @ApiResponse({ status: 302, description: 'Redirect to the storage' })
  @ApiResponse({
    status: 404,
    description: 'No ready video with this slug',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(@Param('slug') slug: string): Promise<{ url: string }> {
    return { url: await this.videosService.getDownloadUrl(slug) };
  }
}
