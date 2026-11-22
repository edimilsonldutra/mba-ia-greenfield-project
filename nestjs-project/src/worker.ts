import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Lets the running jobs finish when the container is stopped.
  app.enableShutdownHooks();
}
void bootstrap();
