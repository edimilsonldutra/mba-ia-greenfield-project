import type { VideoMetadata } from '../videos.types';

export interface ProbedMedia {
  durationSeconds: number;
  metadata: VideoMetadata;
}

/** Subset of the `ffprobe -show_format -show_streams` output. */
export interface ProbeOutput {
  streams?: {
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    disposition?: { attached_pic?: number };
  }[];
  format?: { format_name?: string; duration?: string; bit_rate?: string };
}
