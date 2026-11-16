import { describe, expect, it } from 'vitest';
import {
    CtForbiddenError,
    CtHttpError,
    CtInvalidIdError,
    CtPasswordNotSetError,
    CtRateLimitedError,
    CtValidationError,
    NotAuthenticatedError,
} from './errors';

describe('errors', () => {
    it('set name and fields', () => {
        expect(new NotAuthenticatedError().name).toBe('NotAuthenticatedError');
        expect(new CtForbiddenError('no', 'admin').missing).toBe('admin');
        expect(new CtRateLimitedError(61_000)).toMatchObject({ name: 'CtRateLimitedError', retryAfterMs: 61_000 });
        expect(new CtRateLimitedError(61_000).message).toContain('61 s');
        expect(new CtHttpError(404)).toMatchObject({ name: 'CtHttpError', status: 404, message: 'ChurchTools answered 404' });
        expect(new CtInvalidIdError('x1').message).toBe('Invalid ChurchTools id: x1');
    });

    it('a validation error is an HTTP 400 that keeps its fields', () => {
        const err = new CtValidationError(undefined, [{ fieldId: 'email', messageKey: 'invalid', validOptions: [1] }]);
        expect(err).toBeInstanceOf(CtHttpError);
        expect(err).toMatchObject({ name: 'CtValidationError', status: 400 });
        expect(err.fields[0]?.fieldId).toBe('email');
    });

    it('a password-not-set error names only status details, never request data', () => {
        expect(new CtPasswordNotSetError({ httpStatus: 500 }).message).toContain('HTTP 500');
        expect(new CtPasswordNotSetError({ answer: 'fail' })).toMatchObject({ answer: 'fail' });
        expect(new CtPasswordNotSetError({}).httpStatus).toBeUndefined();
    });
});
