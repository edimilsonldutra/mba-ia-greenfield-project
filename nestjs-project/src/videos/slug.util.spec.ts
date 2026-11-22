import { generateSlug } from './slug.util';

describe('generateSlug', () => {
  it('should generate 11 URL-safe characters', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateSlug()).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });

  it('should not repeat', () => {
    const slugs = new Set(Array.from({ length: 10_000 }, generateSlug));

    expect(slugs.size).toBe(10_000);
  });
});
