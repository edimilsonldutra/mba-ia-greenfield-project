import { randomBytes, randomUUID } from 'node:crypto';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';

export const MIB = 1024 * 1024;

export function createTestS3Client(): S3Client {
  const config = storageConfig();
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
  });
}

export async function createTestStorage(
  overrides: Partial<ReturnType<typeof storageConfig>> = {},
): Promise<StorageService> {
  const storage = new StorageService({ ...storageConfig(), ...overrides });
  await storage.onModuleInit();
  return storage;
}

export function uniqueKey(): string {
  return `tests/${randomUUID()}`;
}

/** Plain PUT, as a browser would send it: no signature and no extra header. */
export async function putPart(url: string, body: Buffer): Promise<Response> {
  return fetch(url, { method: 'PUT', body: new Uint8Array(body) });
}

export function randomContent(size: number): Buffer {
  return randomBytes(size);
}

export async function openUploads(key: string): Promise<string[]> {
  const { Uploads } = await createTestS3Client().send(
    new ListMultipartUploadsCommand({
      Bucket: storageConfig().bucket,
      Prefix: key,
    }),
  );
  return (Uploads ?? []).map((upload) => upload.UploadId!);
}

export async function dropBucket(bucket: string): Promise<void> {
  const client = createTestS3Client();
  const { Contents } = await client.send(
    new ListObjectsV2Command({ Bucket: bucket }),
  );
  if (Contents?.length) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: Contents.map(({ Key }) => ({ Key })) },
      }),
    );
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}
