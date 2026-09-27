import { ApiProperty } from '@nestjs/swagger';

/**
 * The two tokens that make a session (Step 16), in the shape every endpoint that
 * starts or renews one returns.
 *
 * Both halves are returned together and both are returned *here* rather than only
 * the access token, because the client has no other way to get a refresh token: the
 * stored digest is not reversible, so there is no endpoint that can re-issue one for
 * a session the client has already lost.
 *
 * The expiry fields are the counterpart of that: they are ISO-8601 strings, like
 * `VerifyOtpResponseDto.phoneVerifiedAt` and `HealthResponseDto.timestamp`, so the
 * client never has to decode the JWT to find out when it should refresh. A client
 * that refreshes on `accessTokenExpiresAt` (less a margin) never sees a 401 for
 * expiry at all.
 *
 * The access token is a JWT and the refresh token is opaque - deliberately different
 * formats. The client is expected to treat both as strings and to *not* read claims
 * out of either; anything it needs about the user comes from `GET /auth/session`.
 */
export class TokenPairResponseDto {
  @ApiProperty({
    description:
      'JWT to send as `Authorization: Bearer <token>`. Expires after 15 minutes; the token itself carries the expiry.',
    example:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwZjhmYWQ1Yi1kOWNiLTQ2OWYtYTE2NS03MDg2NzcyODk1MGUifQ.4pcPyMD09olPSyXnrXCjTwXyr4BsezdI1AVTmud2fU4',
  })
  accessToken!: string;

  @ApiProperty({
    description: 'When `accessToken` stops being accepted. Refresh before this.',
    example: '2026-09-26T10:19:12.345Z',
  })
  accessTokenExpiresAt!: string;

  @ApiProperty({
    description:
      'Opaque, single-use credential for POST /auth/refresh. Store it wherever the platform keeps secrets for apps - never in a place JavaScript on a shared machine can read. A successful refresh returns a new one and retires this one.',
    example: 'sG7hQ1rT4wYz9kLm2nPqR6vX8bC3dF5gH7jK1mN4pS9',
  })
  refreshToken!: string;

  @ApiProperty({
    description:
      'When `refreshToken` stops being usable. Past this point the user signs in again with a code.',
    example: '2026-10-26T10:04:12.345Z',
  })
  refreshExpiresAt!: string;
}
