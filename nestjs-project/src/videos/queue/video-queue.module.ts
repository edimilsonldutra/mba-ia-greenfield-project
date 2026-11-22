import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VIDEO_PROCESSING } from './video-processing.constants';
import { VideoProcessingQueue } from './video-processing.queue';

@Module({
  imports: [BullModule.registerQueue({ name: VIDEO_PROCESSING.QUEUE })],
  providers: [VideoProcessingQueue],
  exports: [VideoProcessingQueue],
})
export class VideoQueueModule {}
