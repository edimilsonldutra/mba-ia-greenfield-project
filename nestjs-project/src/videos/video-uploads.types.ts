import type { VideoStatus } from './entities/video.entity';

export interface StartedUpload {
  id: string;
  slug: string;
  title: string;
  status: VideoStatus;
  upload: { part_size_bytes: number; part_count: number };
}

export interface SignedParts {
  expires_in: number;
  parts: { part_number: number; url: string }[];
}

export interface UploadProgress {
  part_size_bytes: number;
  part_count: number;
  uploaded_parts: { part_number: number; size_bytes: number }[];
}

export interface CompletedUpload {
  id: string;
  slug: string;
  status: VideoStatus;
}
