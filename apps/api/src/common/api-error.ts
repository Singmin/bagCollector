import { HttpException, HttpStatus } from '@nestjs/common';

export class ApiError extends HttpException {
  constructor(code: string, message: string, status: HttpStatus, details?: unknown) {
    super({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
  }
}
