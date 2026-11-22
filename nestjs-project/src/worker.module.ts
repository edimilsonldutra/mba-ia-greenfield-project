import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { DatabaseModule } from './database/database.module';
import { QueueModule } from './queue/queue.module';
import { VideoProcessingModule } from './videos/processing/video-processing.module';

/** Root of the video worker process: no HTTP, only the queue consumer. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    DatabaseModule,
    QueueModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
