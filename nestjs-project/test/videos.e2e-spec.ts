import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { Channel } from '../src/channels/entities/channel.entity';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createE2eApp, createOwner, TestOwner } from '../src/test/e2e-app';
import { createVideo } from '../src/test/factories';
import { MIB, putPart, randomContent } from '../src/test/storage';
import { VideoStatus } from '../src/videos/entities/video.entity';

const GIB = 1024 ** 3;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let owner: TestOwner;

  beforeAll(async () => {
    app = await createE2eApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(app.get(DataSource));
    owner = await createOwner(app);
  });

  const body = (overrides: object = {}) => ({
    filename: 'holiday.mp4',
    content_type: 'video/mp4',
    size_bytes: 6 * MIB,
    ...overrides,
  });

  const startUpload = (overrides: object = {}) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', owner.authorization)
      .send(body(overrides));

  const signParts = (
    id: string,
    part_numbers: unknown,
    authorization = owner.authorization,
  ) =>
    request(app.getHttpServer())
      .post(`/videos/${id}/upload/parts`)
      .set('Authorization', authorization)
      .send({ part_numbers });

  const getProgress = (id: string, authorization = owner.authorization) =>
    request(app.getHttpServer())
      .get(`/videos/${id}/upload`)
      .set('Authorization', authorization);

  describe('POST /videos', () => {
    it('returns 201 with the draft, its slug and the part plan', async () => {
      const res = await startUpload().expect(201);

      expect(res.body).toEqual({
        id: expect.any(String),
        slug: expect.stringMatching(/^[A-Za-z0-9_-]{11}$/),
        title: 'holiday',
        status: 'draft',
        upload: { part_size_bytes: 5 * MIB, part_count: 2 },
      });
    });

    it('accepts exactly 10 GiB', async () => {
      await startUpload({ size_bytes: 10 * GIB }).expect(201);
    });

    it.each([
      ['one byte above 10 GiB', { size_bytes: 10 * GIB + 1 }],
      ['an empty file', { size_bytes: 0 }],
      ['a fractional size', { size_bytes: 1.5 }],
      ['a content type outside the list', { content_type: 'application/pdf' }],
      ['a missing filename', { filename: undefined }],
      ['control characters in the filename', { filename: 'a\u0000.mp4' }],
      ['an empty title', { title: '' }],
      ['an unknown property', { status: 'ready' }],
    ])('returns 400 for %s', async (_case, overrides) => {
      const res = await startUpload(overrides).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(body())
        .expect(401);
    });

    it('is not rate limited', async () => {
      for (let i = 0; i < 12; i++) await startUpload().expect(201);
    });
  });

  describe('POST /videos/:videoId/upload/parts', () => {
    it('returns one URL per part, which accepts a plain PUT', async () => {
      const { body: video } = await startUpload();

      const res = await signParts(video.id, [1, 2]).expect(200);

      expect(res.body.expires_in).toBe(3600);
      expect(res.body.parts).toHaveLength(2);
      const put = await putPart(res.body.parts[0].url, randomContent(MIB));
      expect(put.status).toBe(200);
    });

    it('returns 400 INVALID_PART_NUMBER above the plan', async () => {
      const { body: video } = await startUpload();

      const res = await signParts(video.id, [3]).expect(400);

      expect(res.body.error).toBe('INVALID_PART_NUMBER');
    });

    it.each([
      ['no part', []],
      ['a repeated part', [1, 1]],
      ['part zero', [0]],
      ['text', ['1']],
      ['more than 100 parts', Array.from({ length: 101 }, (_, i) => i + 1)],
    ])('returns 400 VALIDATION_ERROR for %s', async (_case, parts) => {
      const { body: video } = await startUpload();

      const res = await signParts(video.id, parts).expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for an id that is not a UUID', async () => {
      await signParts('not-a-uuid', [1]).expect(400);
    });

    it('returns 404 for an unknown video and for a video of another user', async () => {
      const { body: video } = await startUpload();
      const other = await createOwner(app);

      const unknown = await signParts(randomUUID(), [1]).expect(404);
      await signParts(video.id, [1], other.authorization).expect(404);

      expect(unknown.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post(`/videos/${randomUUID()}/upload/parts`)
        .send({ part_numbers: [1] })
        .expect(401);
    });
  });

  describe('POST /videos/:videoId/upload/complete', () => {
    const complete = (id: string, authorization = owner.authorization) =>
      request(app.getHttpServer())
        .post(`/videos/${id}/upload/complete`)
        .set('Authorization', authorization);

    async function uploadParts(id: string, sizes: number[]): Promise<void> {
      const { body: signed } = await signParts(
        id,
        sizes.map((_, index) => index + 1),
      );
      for (const [index, part] of signed.parts.entries()) {
        await putPart(part.url, randomContent(sizes[index]));
      }
    }

    it('returns 202 and queues the video', async () => {
      const { body: video } = await startUpload();
      await uploadParts(video.id, [5 * MIB, MIB]);

      const res = await complete(video.id).expect(202);

      expect(res.body).toEqual({
        id: video.id,
        slug: video.slug,
        status: 'processing',
      });
    });

    it('returns 409 UPLOAD_INCOMPLETE when a part is missing', async () => {
      const { body: video } = await startUpload();
      await uploadParts(video.id, [5 * MIB]);

      const res = await complete(video.id).expect(409);

      expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
    });

    it('returns 409 UPLOAD_ALREADY_COMPLETED on every upload route afterwards', async () => {
      const { body: video } = await startUpload();
      await uploadParts(video.id, [5 * MIB, MIB]);
      await complete(video.id).expect(202);

      const responses = [
        await complete(video.id).expect(409),
        await signParts(video.id, [1]).expect(409),
        await getProgress(video.id).expect(409),
      ];

      expect(responses.map((res) => res.body.error)).toEqual(
        Array(3).fill('UPLOAD_ALREADY_COMPLETED'),
      );
    });

    it('returns 404 for a video of another user and 401 without a token', async () => {
      const { body: video } = await startUpload();
      const other = await createOwner(app);

      await complete(video.id, other.authorization).expect(404);
      await request(app.getHttpServer())
        .post(`/videos/${video.id}/upload/complete`)
        .expect(401);
    });
  });

  describe('GET /videos/:videoId/status', () => {
    const getStatus = (id: string, authorization = owner.authorization) =>
      request(app.getHttpServer())
        .get(`/videos/${id}/status`)
        .set('Authorization', authorization);

    it('returns the lifecycle to the owner', async () => {
      const { body: video } = await startUpload();

      const res = await getStatus(video.id).expect(200);

      expect(res.body).toEqual({
        id: video.id,
        slug: video.slug,
        status: 'draft',
        failure_reason: null,
        duration_seconds: null,
        metadata: null,
      });
    });

    it('returns 404 to another user, 401 without a token and 400 for an invalid id', async () => {
      const { body: video } = await startUpload();
      const other = await createOwner(app);

      await getStatus(video.id, other.authorization).expect(404);
      await request(app.getHttpServer())
        .get(`/videos/${video.id}/status`)
        .expect(401);
      await getStatus('not-a-uuid').expect(400);
    });
  });

  describe('public routes', () => {
    const channel = () => ({ id: owner.channelId }) as Channel;
    const paths = ['', '/stream', '/thumbnail', '/download'];

    it.each(paths)('GET /videos/:slug%s answers anonymously', async (path) => {
      const { slug } = await createVideo(app.get(DataSource), channel(), {
        status: VideoStatus.READY,
        thumbnail_key: 'videos/x/thumbnail.jpg',
      });

      const res = await request(app.getHttpServer()).get(
        `/videos/${slug}${path}`,
      );

      expect(res.status).toBe(path === '' ? 200 : 302);
    });

    it.each(paths)(
      'GET /videos/:slug%s returns 404 until the video is ready',
      async (path) => {
        for (const status of [
          VideoStatus.DRAFT,
          VideoStatus.PROCESSING,
          VideoStatus.FAILED,
        ]) {
          const { slug } = await createVideo(app.get(DataSource), channel(), {
            status,
          });

          const res = await request(app.getHttpServer())
            .get(`/videos/${slug}${path}`)
            .expect(404);

          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        }
      },
    );

    it('is not rate limited', async () => {
      const { slug } = await createVideo(app.get(DataSource), channel(), {
        status: VideoStatus.READY,
      });

      for (let i = 0; i < 15; i++) {
        await request(app.getHttpServer())
          .get(`/videos/${slug}/stream`)
          .expect(302);
      }
    });

    it('never exposes storage keys or the upload id', async () => {
      const { slug } = await createVideo(app.get(DataSource), channel(), {
        status: VideoStatus.READY,
        upload_id: 'secret-upload',
      });

      const res = await request(app.getHttpServer()).get(`/videos/${slug}`);

      expect(JSON.stringify(res.body)).not.toMatch(/secret-upload|source|key/);
    });
  });

  describe('GET /videos/:videoId/upload', () => {
    it('lists the parts that already arrived', async () => {
      const { body: video } = await startUpload();
      const { body: signed } = await signParts(video.id, [2]);
      await putPart(signed.parts[0].url, randomContent(MIB));

      const res = await getProgress(video.id).expect(200);

      expect(res.body).toEqual({
        part_size_bytes: 5 * MIB,
        part_count: 2,
        uploaded_parts: [{ part_number: 2, size_bytes: MIB }],
      });
    });

    it('returns 404 for a video of another user', async () => {
      const { body: video } = await startUpload();
      const other = await createOwner(app);

      await getProgress(video.id, other.authorization).expect(404);
    });

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .get(`/videos/${randomUUID()}/upload`)
        .expect(401);
    });
  });
});
