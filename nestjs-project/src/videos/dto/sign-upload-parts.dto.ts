import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { VIDEO_LIMITS } from '../videos.constants';

export class SignUploadPartsDto {
  /** Parts to be uploaded, starting at 1. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VIDEO_LIMITS.MAX_PARTS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}
