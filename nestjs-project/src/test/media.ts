import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function encode(args: string[], extension: string): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'media-'));
  const file = join(directory, `out.${extension}`);
  try {
    await run('ffmpeg', ['-v', 'error', ...args, file]);
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true });
  }
}

const picture = (seconds: number) => [
  '-f',
  'lavfi',
  '-i',
  `testsrc=duration=${seconds}:size=640x360:rate=30`,
];

const sound = (seconds: number) => [
  '-f',
  'lavfi',
  '-i',
  `sine=duration=${seconds}`,
];

export async function createMp4(seconds = 3): Promise<Buffer> {
  return encode(
    [
      ...picture(seconds),
      ...sound(seconds),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
    ],
    'mp4',
  );
}

export async function createWebm(seconds = 2): Promise<Buffer> {
  return encode(
    [...picture(seconds), '-c:v', 'libvpx', '-deadline', 'realtime'],
    'webm',
  );
}

export async function createAudio(seconds = 2): Promise<Buffer> {
  return encode([...sound(seconds), '-c:a', 'aac'], 'm4a');
}

/** A valid MP4 grown to `size` with a `free` box, which every player skips. */
export function padMp4(video: Buffer, size: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size - video.length, 0);
  header.write('free', 4, 'ascii');
  return Buffer.concat([
    video,
    header,
    Buffer.alloc(size - video.length - header.length),
  ]);
}
