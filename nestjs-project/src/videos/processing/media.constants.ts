export const MEDIA = {
  PROBE_TIMEOUT_MS: 60_000,
  FRAME_TIMEOUT_MS: 60_000,
  MAX_OUTPUT_BYTES: 20 * 1024 * 1024,
  FRAME_POSITION: 0.1,
  FRAME_MAX_OFFSET_SECONDS: 10,
  FRAME_MAX_WIDTH: 1280,
} as const;

/**
 * Applied to every input. Only these demuxers are allowed, so a playlist (HLS,
 * concat…) disguised as a video cannot make FFmpeg open other URLs or files.
 */
export const INPUT_RESTRICTIONS = [
  '-protocol_whitelist',
  'http,https,tcp,tls',
  '-format_whitelist',
  'mov,matroska',
  '-rw_timeout',
  '15000000', // microseconds
] as const;

/** Messages of FFmpeg about the transport, not about the file. */
export const TRANSPORT_FAILURE =
  /resolve hostname|Connection (refused|reset|timed out)|timed out|HTTP error|Server returned|Input\/output error|Network is unreachable/i;
