import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  // Host written into the URLs handed to browsers; it is part of the signature.
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET || 'streamtube',
  uploadUrlExpiration: parseInt(
    process.env.S3_UPLOAD_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
  deliveryUrlExpiration: parseInt(
    process.env.S3_DELIVERY_URL_EXPIRATION_SECONDS || '21600',
    10,
  ),
}));
