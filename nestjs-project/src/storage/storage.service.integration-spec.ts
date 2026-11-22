import { randomUUID } from 'node:crypto';
import {
  createTestStorage,
  dropBucket,
  MIB,
  openUploads,
  putPart,
  randomContent,
  uniqueKey,
} from '../test/storage';
import type { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let storage: StorageService;

  beforeAll(async () => {
    storage = await createTestStorage();
  });

  describe('bucket', () => {
    it('should create the bucket when it does not exist and accept it afterwards', async () => {
      const bucket = `boot-${randomUUID()}`;

      const first = await createTestStorage({ bucket });
      const second = await createTestStorage({ bucket });
      await first.putObject('file', Buffer.from('content'), 'text/plain');

      expect(await second.getObjectSize('file')).toBe(7);
      await dropBucket(bucket);
    });

    it('should fail to boot when the storage refuses the credentials', async () => {
      await expect(createTestStorage({ secretKey: 'wrong' })).rejects.toThrow();
    });
  });

  describe('multipart upload', () => {
    it('should assemble parts sent by plain PUT to the presigned URLs', async () => {
      const key = uniqueKey();
      const parts = [randomContent(5 * MIB), randomContent(MIB)];
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      for (const [index, part] of parts.entries()) {
        const url = await storage.presignUploadPart(key, uploadId, index + 1);
        expect((await putPart(url, part)).status).toBe(200);
      }
      const stored = await storage.listParts(key, uploadId);
      await storage.completeMultipartUpload(key, uploadId, stored!);

      expect(stored!.map(({ partNumber, size }) => [partNumber, size])).toEqual(
        [
          [1, 5 * MIB],
          [2, MIB],
        ],
      );
      const url = await storage.presignDownload(key);
      const body = Buffer.from(await (await fetch(url)).arrayBuffer());
      expect(body.equals(Buffer.concat(parts))).toBe(true);
    });

    it('should list only the parts that arrived', async () => {
      const key = uniqueKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const url = await storage.presignUploadPart(key, uploadId, 2);
      await putPart(url, randomContent(MIB));

      const stored = await storage.listParts(key, uploadId);

      expect(stored!.map((part) => part.partNumber)).toEqual([2]);
      expect(await openUploads(key)).toEqual([uploadId]);
    });

    it('should follow every page of the part list', async () => {
      const key = uniqueKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const total = 1005; // the storage lists at most 1000 parts per page
      const numbers = Array.from({ length: total }, (_, index) => index + 1);
      for (let first = 0; first < total; first += 50) {
        await Promise.all(
          numbers.slice(first, first + 50).map(async (number) => {
            const url = await storage.presignUploadPart(key, uploadId, number);
            await putPart(url, Buffer.from('x'));
          }),
        );
      }

      const stored = await storage.listParts(key, uploadId);

      expect(stored!.map((part) => part.partNumber)).toEqual(numbers);
    }, 60_000);

    it('should return null for an upload that was already completed', async () => {
      const key = uniqueKey();
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const url = await storage.presignUploadPart(key, uploadId, 1);
      await putPart(url, randomContent(MIB));
      const stored = await storage.listParts(key, uploadId);
      await storage.completeMultipartUpload(key, uploadId, stored!);

      expect(await storage.listParts(key, uploadId)).toBeNull();
    });

    it('should refuse a part sent to an expired URL', async () => {
      const shortLived = await createTestStorage({ uploadUrlExpiration: 1 });
      const key = uniqueKey();
      const uploadId = await shortLived.createMultipartUpload(key, 'video/mp4');
      const url = await shortLived.presignUploadPart(key, uploadId, 1);
      await new Promise((resolve) => setTimeout(resolve, 2100));

      expect((await putPart(url, randomContent(10))).status).toBe(403);
    });
  });

  describe('delivery', () => {
    const content = Buffer.from('0123456789');
    let key: string;

    beforeAll(async () => {
      key = uniqueKey();
      await storage.putObject(key, content, 'video/mp4');
    });

    it('should answer 206 with the requested bytes to a range request', async () => {
      const url = await storage.presignDownload(key);

      const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
      expect(response.headers.get('content-type')).toBe('video/mp4');
      expect(await response.text()).toBe('2345');
    });

    it('should answer as an attachment with the given filename', async () => {
      const url = await storage.presignDownload(key, 'férias "2026".mp4');

      const response = await fetch(url);

      const disposition = response.headers.get('content-disposition');
      expect(disposition).toContain('attachment; filename="f_rias _2026_.mp4"');
      expect(disposition).toContain(
        "filename*=UTF-8''f%C3%A9rias%20%222026%22.mp4",
      );
    });

    it('should sign public URLs with the public host and internal ones with the Compose host', async () => {
      const external = await createTestStorage({
        publicEndpoint: 'http://cdn.example.com',
      });

      expect(new URL(await external.presignDownload(key)).host).toBe(
        'cdn.example.com',
      );
      expect(new URL(await external.presignInternalDownload(key)).host).toBe(
        'minio:9000',
      );
    });

    it('should deny access without a signature', async () => {
      const { origin, pathname } = new URL(await storage.presignDownload(key));

      expect((await fetch(origin + pathname)).status).toBe(403);
    });

    it('should return null for the size of a missing object', async () => {
      expect(await storage.getObjectSize(uniqueKey())).toBeNull();
    });
  });
});
