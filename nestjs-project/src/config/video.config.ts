import { registerAs } from '@nestjs/config';

const DEFAULT_PART_SIZE_BYTES = 64 * 1024 * 1024;

export default registerAs('video', () => ({
  partSizeBytes: parseInt(
    process.env.VIDEO_PART_SIZE_BYTES || String(DEFAULT_PART_SIZE_BYTES),
    10,
  ),
}));
