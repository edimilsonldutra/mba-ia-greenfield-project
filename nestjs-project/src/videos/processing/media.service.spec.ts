import { InvalidMediaError, MediaToolError } from './media.errors';
import {
  classifyFailure,
  type ExecError,
  toProbedMedia,
} from './media.service';
import type { ProbeOutput } from './media.types';

const failure = (fields: Partial<ExecError>, stderr = ''): ExecError =>
  Object.assign(new Error('failed'), fields, { stderr: Buffer.from(stderr) });

describe('classifyFailure', () => {
  it.each([
    ['Invalid data found when processing input'],
    ['moov atom not found'],
    ['Format not on whitelist'],
  ])('should treat "%s" as invalid media', (message) => {
    const error = classifyFailure('ffprobe', failure({ code: 1 }, message));

    expect(error).toBeInstanceOf(InvalidMediaError);
  });

  it.each([
    ['Failed to resolve hostname minio: Name or service not known'],
    ['Connection refused'],
    ['HTTP error 503 Service Unavailable'],
    ['Server returned 403 Forbidden (access denied)'],
    ['Input/output error'],
  ])('should treat "%s" as transient', (message) => {
    const error = classifyFailure('ffprobe', failure({ code: 1 }, message));

    expect(error).toBeInstanceOf(MediaToolError);
  });

  it('should treat a timeout as transient', () => {
    const error = classifyFailure(
      'ffprobe',
      failure({ code: null, killed: true }),
    );

    expect(error).toBeInstanceOf(MediaToolError);
    expect(error.message).toBe('ffprobe timed out');
  });

  it('should treat a missing binary as transient', () => {
    const error = classifyFailure('ffprobe', failure({ code: 'ENOENT' }));

    expect(error).toBeInstanceOf(MediaToolError);
  });

  it('should not leak the presigned URL in the message', () => {
    const error = classifyFailure(
      'ffprobe',
      failure(
        { code: 1 },
        'http://minio:9000/b/k?X-Amz-Signature=abc: Invalid data found',
      ),
    );

    expect(error.message).not.toContain('X-Amz-Signature');
  });
});

describe('toProbedMedia', () => {
  const video = {
    codec_type: 'video',
    codec_name: 'h264',
    width: 1920,
    height: 1080,
    avg_frame_rate: '30000/1001',
  };
  const probe = (overrides: ProbeOutput = {}): ProbeOutput => ({
    streams: [video, { codec_type: 'audio', codec_name: 'aac' }],
    format: { format_name: 'mov,mp4', duration: '12.5', bit_rate: '800000' },
    ...overrides,
  });

  it('should map duration and metadata', () => {
    expect(toProbedMedia(probe())).toEqual({
      durationSeconds: 12.5,
      metadata: {
        width: 1920,
        height: 1080,
        frame_rate: 29.97,
        video_codec: 'h264',
        audio_codec: 'aac',
        bit_rate: 800000,
        format: 'mov,mp4',
      },
    });
  });

  it('should accept a silent video with unknown rates', () => {
    const { metadata } = toProbedMedia(
      probe({
        streams: [{ ...video, avg_frame_rate: '0/0' }],
        format: { format_name: 'webm', duration: '1' },
      }),
    );

    expect(metadata).toMatchObject({
      frame_rate: null,
      audio_codec: null,
      bit_rate: null,
    });
  });

  it('should not take a cover image for a video stream', () => {
    const cover = { ...video, disposition: { attached_pic: 1 } };

    expect(() => toProbedMedia(probe({ streams: [cover] }))).toThrow(
      InvalidMediaError,
    );
  });

  it.each([undefined, 'N/A', '0'])('should refuse duration %p', (duration) => {
    expect(() =>
      toProbedMedia(probe({ format: { format_name: 'webm', duration } })),
    ).toThrow(InvalidMediaError);
  });
});
