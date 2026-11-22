import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  ACCEPTED_CONTENT_TYPES,
  NO_CONTROL_CHARACTERS,
  VIDEO_LIMITS,
} from '../videos.constants';

export class CreateVideoDto {
  /** Name of the file in the user's device. */
  @IsString()
  @Length(1, VIDEO_LIMITS.MAX_FILENAME_LENGTH)
  @Matches(NO_CONTROL_CHARACTERS)
  filename: string;

  /** MIME type of the file. */
  @IsIn(ACCEPTED_CONTENT_TYPES)
  content_type: string;

  /** Exact size of the file, up to 10 GiB. */
  @IsInt()
  @Min(1)
  @Max(VIDEO_LIMITS.MAX_SIZE_BYTES)
  size_bytes: number;

  /** Defaults to the filename without its extension. */
  @IsOptional()
  @IsString()
  @Length(1, VIDEO_LIMITS.MAX_TITLE_LENGTH)
  @Matches(NO_CONTROL_CHARACTERS)
  title?: string;
}
