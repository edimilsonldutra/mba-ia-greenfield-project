import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { StorageService } from '../../storage/storage.service';
import { createAudio, createMp4, createWebm } from '../../test/media';
import { createTestStorage, uniqueKey } from '../../test/storage';
import { InvalidMediaError, MediaToolError } from './media.errors';
import { MediaService } from './media.service';

describe('MediaService (integration)', () => {
  const media = new MediaService();
  let storage: StorageService;
  let mp4: Buffer;

  async function store(content: Buffer): Promise<string> {
    const key = uniqueKey();
    await storage.putObject(key, content, 'video/mp4');
    return storage.presignInternalDownload(key);
  }

  beforeAll(async () => {
    storage = await createTestStorage();
    mp4 = await createMp4(3);
  }, 30_000);

  describe('probe', () => {
    it('should extract duration and metadata of an MP4', async () => {
      const { durationSeconds, metadata } = await media.probe(await store(mp4));

      expect(durationSeconds).toBeCloseTo(3, 1);
      expect(metadata).toMatchObject({
        width: 640,
        height: 360,
        frame_rate: 30,
        video_codec: 'h264',
        audio_codec: 'aac',
      });
      expect(metadata.bit_rate).toBeGreaterThan(0);
    });

    it('should extract duration and metadata of a WebM', async () => {
      const url = await store(await createWebm(2));

      const { durationSeconds, metadata } = await media.probe(url);

      expect(durationSeconds).toBeCloseTo(2, 1);
      expect(metadata).toMatchObject({ video_codec: 'vp8', audio_codec: null });
    });

    it.each([
      ['text', Buffer.from('this is not a video')],
      ['a single byte', Buffer.alloc(1)],
      ['a truncated MP4', undefined],
    ])('should refuse %s', async (_case, content) => {
      const url = await store(content ?? mp4.subarray(0, 2000));

      await expect(media.probe(url)).rejects.toThrow(InvalidMediaError);
    });

    it('should refuse an audio file', async () => {
      const url = await store(await createAudio());

      await expect(media.probe(url)).rejects.toThrow(InvalidMediaError);
    });

    it('should report an unreachable host as transient', async () => {
      await expect(
        media.probe('http://unreachable.invalid/video'),
      ).rejects.toThrow(MediaToolError);
    });

    it('should report a missing object as transient', async () => {
      const url = await storage.presignInternalDownload(uniqueKey());

      await expect(media.probe(url)).rejects.toThrow(MediaToolError);
    });
  });

  describe('hostile input', () => {
    let server: Server;
    let origin: string;
    let requests: string[];

    beforeAll(async () => {
      server = createServer((req, res) => {
        requests.push(req.url!);
        res.end(mp4);
      });
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const { port } = server.address() as AddressInfo;
      origin = `http://127.0.0.1:${port}`;
    });

    beforeEach(() => {
      requests = [];
    });

    afterAll(() => {
      server.close();
    });

    it.each([
      [
        'an HLS playlist',
        () =>
          `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n${origin}/internal.ts\n#EXT-X-ENDLIST\n`,
      ],
      ['a concat script', () => `ffconcat version 1.0\nfile ${origin}/x.mp4\n`],
      [
        'a playlist of local files',
        () => '#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n',
      ],
    ])('should refuse %s without opening its entries', async (_c, content) => {
      const url = await store(Buffer.from(content()));

      await expect(media.probe(url)).rejects.toThrow(InvalidMediaError);
      await expect(media.captureFrame(url, 10)).rejects.toThrow(
        InvalidMediaError,
      );
      expect(requests).toEqual([]);
    });
  });

  describe('captureFrame', () => {
    it('should return a JPEG', async () => {
      const frame = await media.captureFrame(await store(mp4), 3);

      expect(frame.subarray(0, 3).toString('hex')).toBe('ffd8ff');
      expect(frame.length).toBeGreaterThan(1000);
    });

    it('should capture a very short video', async () => {
      const url = await store(await createMp4(0.2));

      const frame = await media.captureFrame(url, 0.2);

      expect(frame.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    });

    it('should refuse a file that cannot be decoded', async () => {
      const url = await store(Buffer.from('nothing to see'));

      await expect(media.captureFrame(url, 10)).rejects.toThrow(
        InvalidMediaError,
      );
    });
  });
});
