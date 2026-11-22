import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import {
  INPUT_RESTRICTIONS,
  MEDIA,
  TRANSPORT_FAILURE,
} from './media.constants';
import { InvalidMediaError, MediaToolError } from './media.errors';
import type { ProbedMedia, ProbeOutput } from './media.types';

const run = promisify(execFile);

/**
 * Reads media through `ffprobe` and `ffmpeg`. The input is a URL: only the
 * byte ranges needed are requested, so large files are never copied.
 */
@Injectable()
export class MediaService {
  async probe(url: string): Promise<ProbedMedia> {
    const output = await this.execute(
      'ffprobe',
      [
        '-v',
        'error',
        ...INPUT_RESTRICTIONS,
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      MEDIA.PROBE_TIMEOUT_MS,
    );
    return toProbedMedia(JSON.parse(output.toString()) as ProbeOutput);
  }

  async captureFrame(url: string, durationSeconds: number): Promise<Buffer> {
    const offset = Math.min(
      durationSeconds * MEDIA.FRAME_POSITION,
      MEDIA.FRAME_MAX_OFFSET_SECONDS,
    );
    const frame = await this.execute(
      'ffmpeg',
      [
        '-v',
        'error',
        ...INPUT_RESTRICTIONS,
        '-ss',
        offset.toFixed(3),
        '-i',
        url,
        '-map',
        '0:V:0', // first video stream that is not a cover image
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${MEDIA.FRAME_MAX_WIDTH},iw)':-2`,
        '-q:v',
        '3',
        '-f',
        'image2pipe',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      MEDIA.FRAME_TIMEOUT_MS,
    );
    if (frame.length === 0) {
      throw new InvalidMediaError('No frame could be decoded');
    }
    return frame;
  }

  private async execute(
    binary: string,
    args: string[],
    timeout: number,
  ): Promise<Buffer> {
    try {
      const { stdout } = await run(binary, args, {
        timeout,
        killSignal: 'SIGKILL',
        encoding: 'buffer',
        maxBuffer: MEDIA.MAX_OUTPUT_BYTES,
      });
      return stdout;
    } catch (error) {
      throw classifyFailure(binary, error as ExecError);
    }
  }
}

export interface ExecError extends Error {
  /** Exit code, or an errno name when the process could not run. */
  code?: number | string | null;
  killed?: boolean;
  stderr?: Buffer;
}

/** The exit code says it failed; the message tells whose fault it was. */
export function classifyFailure(binary: string, error: ExecError): Error {
  // The input URL is a credential and FFmpeg repeats it in its messages.
  const details = (error.stderr?.toString() ?? '')
    .replace(/https?:\/\/\S+/g, '<url>')
    .trim();

  if (error.killed) return new MediaToolError(`${binary} timed out`);
  if (typeof error.code !== 'number') {
    return new MediaToolError(`${binary} did not run: ${error.code}`);
  }
  return TRANSPORT_FAILURE.test(details)
    ? new MediaToolError(`${binary}: ${details}`)
    : new InvalidMediaError(`${binary}: ${details}`);
}

export function toProbedMedia(probe: ProbeOutput): ProbedMedia {
  const streams = probe.streams ?? [];
  const video = streams.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const durationSeconds = Number(probe.format?.duration);

  if (!video?.width || !video.height || !video.codec_name) {
    throw new InvalidMediaError('The file has no video stream');
  }
  if (!(durationSeconds > 0)) {
    throw new InvalidMediaError('The file has no duration');
  }

  return {
    durationSeconds,
    metadata: {
      width: video.width,
      height: video.height,
      frame_rate: parseFrameRate(video.avg_frame_rate),
      video_codec: video.codec_name,
      audio_codec: audio?.codec_name ?? null,
      bit_rate: Number(probe.format?.bit_rate) || null,
      format: probe.format?.format_name ?? '',
    },
  };
}

/** `30000/1001` → 29.97 */
function parseFrameRate(rate = ''): number | null {
  const [numerator, denominator] = rate.split('/').map(Number);
  if (!numerator || !denominator) return null;
  return Math.round((numerator / denominator) * 100) / 100;
}
