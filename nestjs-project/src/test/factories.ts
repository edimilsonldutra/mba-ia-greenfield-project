import { randomUUID } from 'node:crypto';
import type { DataSource, DeepPartial } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

let counter = 0;

function nextId(): string {
  return `${Date.now().toString(36)}${(++counter).toString(36)}`;
}

export async function createChannel(dataSource: DataSource): Promise<Channel> {
  const id = nextId();
  const user = await dataSource.getRepository(User).save({
    email: `user_${id}@example.com`,
    password: 'hashed',
    is_confirmed: true,
  });
  return dataSource.getRepository(Channel).save({
    name: `Channel ${id}`,
    nickname: `channel_${id}`,
    user_id: user.id,
  });
}

export async function createVideo(
  dataSource: DataSource,
  channel: Channel,
  overrides: DeepPartial<Video> = {},
): Promise<Video> {
  const id = randomUUID();
  return dataSource.getRepository(Video).save({
    id,
    channel_id: channel.id,
    slug: id.replace(/-/g, '').slice(0, 11),
    title: 'A video',
    original_filename: 'video.mp4',
    content_type: 'video/mp4',
    size_bytes: 1000,
    storage_key: `videos/${id}/source`,
    part_size_bytes: 5 * 1024 * 1024,
    ...overrides,
  }) as Promise<Video>;
}
