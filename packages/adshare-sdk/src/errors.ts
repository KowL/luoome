export type AdshareErrorCode =
  | 'CONFIG_MISSING'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'TIMEOUT'
  | 'PARSE_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_INPUT';

/**
 * Adshare SDK 统一错误。
 */
export class AdshareError extends Error {
  override readonly name = 'AdshareError';
  readonly code: AdshareErrorCode;
  readonly status: number | undefined;
  override readonly cause: unknown | undefined;

  constructor(
    code: AdshareErrorCode,
    message: string,
    options?: { readonly status?: number; readonly cause?: unknown },
  ) {
    super(message);
    this.code = code;
    this.status = options?.status;
    this.cause = options?.cause;
  }
}
