import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoQueueModule } from './queue/video-queue.module';
import { VideoUploadsController } from './video-uploads.controller';
import { VideoUploadsService } from './video-uploads.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    VideoQueueModule,
  ],
  controllers: [VideoUploadsController, VideosController],
  providers: [VideoUploadsService, VideosService],
})
export class VideosModule {}
