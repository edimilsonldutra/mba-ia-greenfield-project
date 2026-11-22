import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import { VideoUploadsService } from './video-uploads.service';
import type {
  CompletedUpload,
  SignedParts,
  StartedUpload,
  UploadProgress,
} from './video-uploads.types';

@ApiTags('videos')
@SkipThrottle()
@Controller('videos')
export class VideoUploadsController {
  constructor(private readonly uploadsService: VideoUploadsService) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Registers the video as a draft, with its unique URL, and opens a multipart upload in the object storage. The file itself is never sent to the API.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string', example: 'dQw4w9WgXcQ' },
        title: { type: 'string' },
        status: { type: 'string', enum: ['draft'] },
        upload: {
          type: 'object',
          properties: {
            part_size_bytes: { type: 'integer' },
            part_count: { type: 'integer' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'The user has no channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async start(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<StartedUpload> {
    return this.uploadsService.start(user.sub, dto);
  }

  @Post(':videoId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Sign upload parts',
    description:
      'Returns one URL per part. Each part is sent straight to the object storage by PUT, and may be sent again if it fails.',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed URLs',
    schema: {
      properties: {
        expires_in: { type: 'integer', description: 'Seconds' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string', format: 'uri' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number outside the upload plan',
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
  @ApiResponse({
    status: 409,
    description: 'Upload already completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignedParts> {
    return this.uploadsService.signParts(user.sub, videoId, dto.part_numbers);
  }

  @Get(':videoId/upload')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get upload progress',
    description:
      'Lists the parts that already reached the storage, so an interrupted upload can be resumed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload progress',
    schema: {
      properties: {
        part_size_bytes: { type: 'integer' },
        part_count: { type: 'integer' },
        uploaded_parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              size_bytes: { type: 'integer' },
            },
          },
        },
      },
    },
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
  @ApiResponse({
    status: 409,
    description: 'Upload already completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getProgress(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
  ): Promise<UploadProgress> {
    return this.uploadsService.getProgress(user.sub, videoId);
  }

  @Post(':videoId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Verifies the parts in the storage, assembles the file and queues the video for processing. Follow the outcome with GET /videos/:videoId/status.',
  })
  @ApiResponse({
    status: 202,
    description: 'Video queued for processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
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
  @ApiResponse({
    status: 409,
    description: 'Upload incomplete or already completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 503,
    description: 'Processing queue unavailable; the call can be repeated',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('videoId', ParseUUIDPipe) videoId: string,
  ): Promise<CompletedUpload> {
    return this.uploadsService.complete(user.sub, videoId);
  }
}
