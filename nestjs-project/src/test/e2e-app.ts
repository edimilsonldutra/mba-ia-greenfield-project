import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { DomainExceptionFilter } from '../common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../common/filters/validation-exception.filter';
import { createChannel } from './factories';

/** Boots the whole application with the same global pipes and filters as main.ts. */
export async function createE2eApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

export interface TestOwner {
  userId: string;
  channelId: string;
  authorization: string;
}

/** A confirmed user with a channel and a valid access token. */
export async function createOwner(app: INestApplication): Promise<TestOwner> {
  const channel = await createChannel(app.get(DataSource));
  const token = await app.get(JwtService).signAsync({
    sub: channel.user_id,
    email: 'owner@example.com',
    jti: randomUUID(),
  });
  return {
    userId: channel.user_id,
    channelId: channel.id,
    authorization: `Bearer ${token}`,
  };
}
