/**
 * Unified Error Handling Middleware
 *
 * Standardizes error responses across the application
 */

const logger = require('../services/logger');

/**
 * Standard error response format
 */
function createErrorResponse(error, statusCode = 500, details = null) {
    const response = {
        error: error.name || 'Error',
        message: error.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString()
    };

    // Include details in development mode only
    if (process.env.NODE_ENV !== 'production' && details) {
        response.details = details;
    }

    // Include stack trace in development mode only
    if (process.env.NODE_ENV !== 'production' && error.stack) {
        response.stack = error.stack;
    }

    return { response, statusCode };
}

/**
 * Express error handling middleware
 * Must be used as the last middleware in the chain
 */
function errorHandler(err, req, res, next) {
    const requestId = req.requestId || 'unknown';
    
    // Log the error
    logger.error({
        requestId,
        error: err.message,
        stack: err.stack,
        url: req.url,
        method: req.method,
        ip: req.ip,
        statusCode: err.status || 500,
        body: req.body ? Object.keys(req.body) : null
    }, 'Request error');

    // Handle known error types
    if (err.name === 'ValidationError' || err.status === 400) {
        const { response, statusCode } = createErrorResponse(err, 400);
        response.requestId = requestId;
        return res.status(statusCode).json(response);
    }

    if (err.name === 'UnauthorizedError' || err.status === 401) {
        const { response, statusCode } = createErrorResponse(err, 401);
        return res.status(statusCode).json(response);
    }

    if (err.name === 'ForbiddenError' || err.status === 403) {
        const { response, statusCode } = createErrorResponse(err, 403);
        return res.status(statusCode).json(response);
    }

    if (err.name === 'NotFoundError' || err.status === 404) {
        const { response, statusCode } = createErrorResponse(err, 404);
        return res.status(statusCode).json(response);
    }

    // Handle database errors
    if (err.code && err.code.startsWith('P')) {
        // PostgreSQL error codes
        const { response, statusCode } = createErrorResponse(
            new Error('Database error occurred'),
            500,
            process.env.NODE_ENV !== 'production' ? err.message : null
        );
        return res.status(statusCode).json(response);
    }

    // Handle API errors (OpenAI, Google, etc.)
    if (err.response) {
        const statusCode = err.response.status || 500;
        const { response, statusCode: finalStatusCode } = createErrorResponse(
            new Error(`External API error: ${err.response.statusText || err.message}`),
            statusCode,
            process.env.NODE_ENV !== 'production' ? err.message : null
        );
        return res.status(finalStatusCode).json(response);
    }

    // Default error handler
    const { response, statusCode } = createErrorResponse(err, err.status || 500);
    response.requestId = requestId;
    res.status(statusCode).json(response);
}

/**
 * Async error wrapper - wraps async route handlers to catch errors
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * Create standardized error objects
 */
class AppError extends Error {
    constructor(message, statusCode = 500, name = 'AppError') {
        super(message);
        this.name = name;
        this.status = statusCode;
        Error.captureStackTrace(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message) {
        super(message, 400, 'ValidationError');
    }
}

class UnauthorizedError extends AppError {
    constructor(message = 'Unauthorized') {
        super(message, 401, 'UnauthorizedError');
    }
}

class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
        super(message, 403, 'ForbiddenError');
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404, 'NotFoundError');
    }
}

module.exports = {
    errorHandler,
    asyncHandler,
    AppError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    createErrorResponse
};

