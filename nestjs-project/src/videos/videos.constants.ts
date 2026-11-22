export const VIDEO_LIMITS = {
  MAX_SIZE_BYTES: 10 * 1024 ** 3,
  MAX_PARTS_PER_REQUEST: 100,
  MAX_FILENAME_LENGTH: 255,
  MAX_TITLE_LENGTH: 100,
  MAX_SLUG_ATTEMPTS: 5,
} as const;

export const ACCEPTED_CONTENT_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
] as const;

/** Every object of a video lives under its own prefix; user input is never a key. */
export const VIDEO_KEYS = {
  source: (videoId: string): string => `videos/${videoId}/source`,
  thumbnail: (videoId: string): string => `videos/${videoId}/thumbnail.jpg`,
} as const;

export const NO_CONTROL_CHARACTERS = /^\P{Cc}+$/u;
