import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and video', () => {
  it.each(['S3_ACCESS_KEY', 'S3_SECRET_KEY'])('should require %s', (name) => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, [name]: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error!.message).toContain(name);
  });

  it('should apply the Compose service names as defaults', () => {
    const { value } = validate({});
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_BUCKET: 'streamtube',
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
    });
  });

  it('should default to 64 MiB parts', () => {
    expect(validate({}).value.VIDEO_PART_SIZE_BYTES).toBe(64 * 1024 * 1024);
  });

  it('should reject a part size below the S3 minimum', () => {
    const { error } = validate({ VIDEO_PART_SIZE_BYTES: '1024' });
    expect(error!.message).toContain('VIDEO_PART_SIZE_BYTES');
  });
});
