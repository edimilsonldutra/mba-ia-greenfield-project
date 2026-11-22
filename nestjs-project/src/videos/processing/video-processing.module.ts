import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../../storage/storage.module';
import { UsersModule } from '../../users/users.module';
import { Video } from '../entities/video.entity';
import { VIDEO_PROCESSING } from '../queue/video-processing.constants';
import { MediaService } from './media.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideoProcessingService } from './video-processing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    UsersModule, // registers User and Channel, related to Video
    StorageModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING.QUEUE }),
  ],
  providers: [MediaService, VideoProcessingService, VideoProcessingProcessor],
})
export class VideoProcessingModule {}
