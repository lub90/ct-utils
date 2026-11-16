/** Errors of the ChurchTools layer. Callers never see axios errors, only these (or a network error, unchanged). */

/** Nobody is logged in: `401`, or `whoami` answered with id -1 / 0 (anonymous). */
export class NotAuthenticatedError extends Error {
    constructor(message = 'Not logged in to ChurchTools') {
        super(message);
        this.name = 'NotAuthenticatedError';
    }
}

/** `403`: a right is missing. `missing` names it when the call knows which one it was. */
export class CtForbiddenError extends Error {
    missing?: string;
    constructor(message = 'Forbidden by ChurchTools', missing?: string) {
        super(message);
        this.name = 'CtForbiddenError';
        this.missing = missing;
    }
}

/** `429`: wait `retryAfterMs` (at least 60 s) before the next request. */
export class CtRateLimitedError extends Error {
    retryAfterMs: number;
    constructor(retryAfterMs: number) {
        super(`ChurchTools rate limit reached, retry in ${Math.ceil(retryAfterMs / 1000)} s`);
        this.name = 'CtRateLimitedError';
        this.retryAfterMs = retryAfterMs;
    }
}

/** Any other HTTP failure (`400`, `404`, `5xx`, ...). */
export class CtHttpError extends Error {
    status: number;
    constructor(status: number, message?: string) {
        super(message ?? `ChurchTools answered ${status}`);
        this.name = 'CtHttpError';
        this.status = status;
    }
}

/** A numeric ID that would end up in a request path isn't a positive safe integer. Thrown before any request. */
export class CtInvalidIdError extends Error {
    constructor(value: unknown) {
        super(`Invalid ChurchTools id: ${String(value)}`);
        this.name = 'CtInvalidIdError';
    }
}

/** One field of a `400 There are validation errors` answer. `validOptions` are the allowed IDs ChurchTools names, if any. */
export interface CtFieldError {
    fieldId: string;
    messageKey: string;
    validOptions: number[];
}

/** A `400` with field errors (`errors[]`), e.g. of `POST /persons`. A duplicate-person answer has no fields. */
export class CtValidationError extends CtHttpError {
    fields: CtFieldError[];
    constructor(message: string | undefined, fields: CtFieldError[]) {
        super(400, message);
        this.name = 'CtValidationError';
        this.fields = fields;
    }
}

/**
 * `setPersonPassword` did not answer JSON `status: 'success'`. `httpStatus` is the HTTP status of a failed request
 * (none for a network error or a `200` with another status), `answer` the JSON `status` (`fail`, `error`) if there was
 * one. Carries nothing of the request: never the password.
 */
export class CtPasswordNotSetError extends Error {
    httpStatus?: number;
    answer?: string;
    constructor(detail: { httpStatus?: number; answer?: string }) {
        const why = detail.httpStatus !== undefined ? `HTTP ${detail.httpStatus}` : detail.answer !== undefined ? `status ${detail.answer}` : 'no success answer';
        super(`ChurchTools did not set the password (${why})`);
        this.name = 'CtPasswordNotSetError';
        if (detail.httpStatus !== undefined) this.httpStatus = detail.httpStatus;
        if (detail.answer !== undefined) this.answer = detail.answer;
    }
}
