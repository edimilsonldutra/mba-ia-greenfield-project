export interface VideoMetadata {
  width: number;
  height: number;
  frame_rate: number | null;
  video_codec: string;
  audio_codec: string | null;
  bit_rate: number | null;
  format: string;
}
