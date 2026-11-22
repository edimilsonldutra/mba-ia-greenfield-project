import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NoSuchUpload,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import type { StoredPart } from './storage.types';

@Injectable()
export class StorageService implements OnModuleInit {
  /** Used for every call made by this process. */
  private readonly client: S3Client;
  /** Only signs URLs: the host it is configured with is the one browsers use. */
  private readonly publicClient: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = this.createClient(config.endpoint);
    this.publicClient = this.createClient(config.publicEndpoint);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    return UploadId!;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.uploadUrlExpiration },
    );
  }

  /** Parts already stored, or `null` when the multipart upload no longer exists. */
  async listParts(key: string, uploadId: string): Promise<StoredPart[] | null> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    try {
      // Not `paginateListParts`: MinIO sends NextPartNumberMarker on the last
      // page too, and the SDK paginator would never stop.
      do {
        const page = await this.client.send(
          new ListPartsCommand({
            Bucket: this.config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber!,
            size: part.Size!,
            etag: part.ETag!,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (error) {
      if (error instanceof NoSuchUpload) return null;
      throw error;
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: StoredPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map(({ partNumber, etag }) => ({
            PartNumber: partNumber,
            ETag: etag,
          })),
        },
      }),
    );
  }

  /** Object size in bytes, or `null` when the object does not exist. */
  async getObjectSize(key: string): Promise<number | null> {
    try {
      const { ContentLength } = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return ContentLength ?? null;
    } catch (error) {
      if (error instanceof NotFound) return null;
      throw error;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** URL for browsers. With `attachmentName`, the storage answers as a download. */
  async presignDownload(key: string, attachmentName?: string): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ResponseContentDisposition:
          attachmentName && toAttachment(attachmentName),
      }),
      { expiresIn: this.config.deliveryUrlExpiration },
    );
  }

  /** URL for processes inside the Compose network (the video worker). */
  async presignInternalDownload(key: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: this.config.deliveryUrlExpiration },
    );
  }

  private createClient(endpoint: string): S3Client {
    return new S3Client({
      endpoint,
      region: this.config.region,
      forcePathStyle: true,
      // The default adds a checksum to presigned URLs, and a plain PUT without
      // that checksum would be refused.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: this.config.accessKey,
        secretAccessKey: this.config.secretKey,
      },
    });
  }

  private async ensureBucket(): Promise<void> {
    const bucket = { Bucket: this.config.bucket };
    try {
      await this.client.send(new HeadBucketCommand(bucket));
    } catch (error) {
      if (!(error instanceof NotFound)) throw error;
      await this.client.send(new CreateBucketCommand(bucket));
    }
  }
}

function toAttachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
