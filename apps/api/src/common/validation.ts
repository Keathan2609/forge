import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { type ZodError, type ZodType, type ZodTypeDef } from 'zod';

/**
 * Zod validation at the HTTP boundary.
 *
 * Every request body and query string is parsed by the same schema the SDK and CLI are
 * generated from, so "valid according to the client" and "valid according to the server"
 * cannot drift. Unknown keys are rejected rather than stripped: silently discarding a
 * misspelled field is how a caller ends up debugging a workflow that ignored half its
 * configuration.
 */

export class ValidationFailedException extends BadRequestException {
  constructor(issues: ZodError['issues']) {
    super({
      statusCode: 400,
      error: 'ValidationFailed',
      message: 'request validation failed',
      details: issues.map((issue) => ({
        path: issue.path.join('.') || '$',
        code: issue.code,
        message: issue.message,
      })),
    });
  }
}

/**
 * The schema type a validation pipe accepts.
 *
 * `ZodSchema<T>` is `ZodType<T, ZodTypeDef, T>` — it assumes the parsed input has the
 * same shape as the output. That is false for every schema with a `.default()`, where
 * the input is partial and the output is complete. Declaring the input as `unknown` says
 * what a validation pipe actually does: it turns untrusted input of unknown shape into a
 * value of type `T`, or throws.
 */
export type ValidationSchema<T> = ZodType<T, ZodTypeDef, unknown>;

@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ValidationSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ValidationFailedException(result.error.issues);
    return result.data;
  }
}

/** Convenience factory so controllers read `@Body(zodBody(Schema))`. */
export function zodBody<T>(schema: ValidationSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

export function zodQuery<T>(schema: ValidationSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/**
 * Validate a path parameter that must be a UUID.
 *
 * Without this a malformed id reaches Prisma and surfaces as a 500 with a driver-level
 * message; with it the caller gets a 400 that says which parameter was wrong.
 */
@Injectable()
export class UuidPipe implements PipeTransform<string, string> {
  private static readonly PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  transform(value: string): string {
    if (!UuidPipe.PATTERN.test(value)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'InvalidIdentifier',
        message: '"' + value.slice(0, 64) + '" is not a valid identifier',
      });
    }
    return value;
  }
}

/** Workflow keys are slugs, and are interpolated into queue names and log lines. */
@Injectable()
export class WorkflowKeyPipe implements PipeTransform<string, string> {
  private static readonly PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

  transform(value: string): string {
    if (value.length > 64 || !WorkflowKeyPipe.PATTERN.test(value)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'InvalidIdentifier',
        message: 'workflow key must be lowercase alphanumeric, optionally separated by . _ or -',
      });
    }
    return value;
  }
}
