import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { createE2eApp } from '../src/test/e2e-app';
import { createMp4, padMp4 } from '../src/test/media';
import { waitFor } from '../src/test/queue';
import { MIB, putPart } from '../src/test/storage';
import { WorkerModule } from '../src/worker.module';

/** The real chain: API, PostgreSQL, MinIO, Redis, worker and FFmpeg. */
describe('Video upload flow (e2e)', () => {
  const credentials = { email: 'flow@example.com', password: 'password123' };
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let authorization: string;

  beforeAll(async () => {
    app = await createE2eApp();
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    worker = await module.init();
    await cleanAllTables(app.get(DataSource));
    authorization = await registerConfirmAndLogin();
  }, 60_000);

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function registerConfirmAndLogin(): Promise<string> {
    const send = jest
      .spyOn(app.get(MailService), 'sendConfirmationEmail')
      .mockResolvedValue(undefined);
    await http().post('/auth/register').send(credentials).expect(201);
    const token = send.mock.calls[0][2];
    await http().get('/auth/confirm-email').query({ token }).expect(204);
    const login = await http().post('/auth/login').send(credentials);
    return `Bearer ${login.body.access_token}`;
  }

  async function upload(
    content: Buffer,
    filename: string,
  ): Promise<{ id: string; slug: string }> {
    const { body: video } = await http()
      .post('/videos')
      .set('Authorization', authorization)
      .send({
        filename,
        content_type: 'video/mp4',
        size_bytes: content.length,
      })
      .expect(201);

    const { part_size_bytes: partSize, part_count: partCount } = video.upload;
    const part_numbers = Array.from({ length: partCount }, (_, i) => i + 1);
    const { body: signed } = await http()
      .post(`/videos/${video.id}/upload/parts`)
      .set('Authorization', authorization)
      .send({ part_numbers })
      .expect(200);
    for (const { part_number, url } of signed.parts) {
      const start = (part_number - 1) * partSize;
      const part = content.subarray(start, start + partSize);
      expect((await putPart(url, part)).status).toBe(200);
    }

    await http()
      .post(`/videos/${video.id}/upload/complete`)
      .set('Authorization', authorization)
      .expect(202);
    return video;
  }

  const getStatus = async (id: string) =>
    (
      await http()
        .get(`/videos/${id}/status`)
        .set('Authorization', authorization)
        .expect(200)
    ).body;

  const waitForStatus = (id: string, status: string) =>
    waitFor(async () => (await getStatus(id)).status === status, 30_000);

  it('should take a multipart upload to a video that anyone can watch and download', async () => {
    const content = padMp4(await createMp4(3), 12 * MIB);

    const { id, slug } = await upload(content, 'férias.mp4');
    await waitForStatus(id, 'ready');

    // The owner sees what was extracted.
    expect(await getStatus(id)).toMatchObject({
      duration_seconds: expect.closeTo(3, 1),
      metadata: { width: 640, height: 360, video_codec: 'h264' },
      failure_reason: null,
    });

    // From here on, no token: anonymous viewer.
    const details = await http().get(`/videos/${slug}`).expect(200);
    expect(details.body).toMatchObject({
      slug,
      title: 'férias',
      channel: { nickname: 'flow' },
    });

    const stream = await http().get(details.body.stream_url).expect(302);
    expect(stream.headers['cache-control']).toBe('no-store');
    const range = await fetch(stream.headers.location, {
      headers: { Range: `bytes=${MIB}-${MIB + 99}` },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      content.subarray(MIB, MIB + 100),
    );

    const download = await http().get(details.body.download_url).expect(302);
    const file = await fetch(download.headers.location);
    expect(file.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''f%C3%A9rias.mp4",
    );
    expect(Buffer.from(await file.arrayBuffer()).equals(content)).toBe(true);

    const thumbnail = await http().get(details.body.thumbnail_url).expect(302);
    const image = await fetch(thumbnail.headers.location);
    expect(image.headers.get('content-type')).toBe('image/jpeg');
  }, 60_000);

  it('should tell the owner that the file is not a video, and show it to nobody else', async () => {
    const { id, slug } = await upload(Buffer.from('not a video'), 'fake.mp4');
    await waitForStatus(id, 'failed');

    expect((await getStatus(id)).failure_reason).toBe('INVALID_VIDEO');
    await http().get(`/videos/${slug}`).expect(404);
    await http().get(`/videos/${slug}/stream`).expect(404);
  }, 60_000);

  it('should give each video its own URL', async () => {
    const content = await createMp4(1);

    const [first, second] = [
      await upload(content, 'same.mp4'),
      await upload(content, 'same.mp4'),
    ];

    expect(first.slug).not.toBe(second.slug);
  }, 60_000);
});
