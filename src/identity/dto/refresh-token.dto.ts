import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body of `POST /v1/auth/refresh` and `POST /v1/auth/logout` (Step 16).
 *
 * One class for both because both take the same single value, and the alternative -
 * two identical bodies - is how one of them ends up documented as taking something
 * else.
 *
 * The refresh token is sent in the body rather than in the `Authorization` header,
 * unlike the access token. Two reasons: the header already has a meaning for this API
 * (the access token, and a guard that reads it), and a refresh token is rotated on use
 * - putting a value in a header invites it being replayed with `curl -H` from a shell
 * history and from logs, while a body is the shape that says "this is a credential
 * being exchanged, not a standing identity".
 *
 * Validation stops at "a non-empty string". Whether the value is *a* refresh token at
 * all is answered by `TokenService` with the same 401 as an expired or revoked one -
 * a 400 for a malformed value would be a free hint that the shape is worth guessing
 * at, and the client's next step is identical either way.
 */
export class RefreshTokenDto {
  @ApiProperty({
    description:
      'The `refreshToken` from the most recent login, verification or refresh response. Single-use: a successful refresh returns a new one and retires this one.',
    example: 'sG7hQ1rT4wYz9kLm2nPqR6vX8bC3dF5gH7jK1mN4pS9',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
