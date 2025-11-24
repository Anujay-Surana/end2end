/**
 * Request Logging Middleware
 *
 * Logs incoming requests with sanitized data and generates request IDs for tracing
 */

const logger = require('../services/logger');
const crypto = require('crypto');

/**
 * Sanitize sensitive data from request body
 */
function sanitizeBody(body) {
    if (!body || typeof body !== 'object') {
        return body;
    }

    const sanitized = { ...body };
    
    // Remove sensitive fields
    const sensitiveFields = ['accessToken', 'refresh_token', 'password', 'token', 'authorization'];
    
    for (const field of sensitiveFields) {
        if (sanitized[field]) {
            sanitized[field] = '[REDACTED]';
        }
    }

    // Truncate long strings
    function truncateLongValues(obj, maxLength = 200) {
        for (const key in obj) {
            if (typeof obj[key] === 'string' && obj[key].length > maxLength) {
                obj[key] = obj[key].substring(0, maxLength) + '... [truncated]';
            } else if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
                truncateLongValues(obj[key], maxLength);
            } else if (Array.isArray(obj[key])) {
                obj[key] = obj[key].map(item => {
                    if (typeof item === 'string' && item.length > maxLength) {
                        return item.substring(0, maxLength) + '... [truncated]';
                    }
                    if (typeof item === 'object' && item !== null) {
                        const sanitizedItem = { ...item };
                        truncateLongValues(sanitizedItem, maxLength);
                        return sanitizedItem;
                    }
                    return item;
                });
            }
        }
    }

    truncateLongValues(sanitized);
    return sanitized;
}

/**
 * Sanitize headers (remove sensitive auth headers)
 */
function sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    if (sanitized.authorization) {
        sanitized.authorization = '[REDACTED]';
    }
    if (sanitized.cookie) {
        // Keep cookie name but redact value
        sanitized.cookie = sanitized.cookie.split('=')[0] + '=[REDACTED]';
    }
    return sanitized;
}

/**
 * Request logging middleware
 * Generates request ID and logs request details
 */
function requestLogger(req, res, next) {
    // Generate unique request ID using crypto.randomUUID() (built into Node.js 18+)
    const requestId = `req-${crypto.randomUUID().split('-')[0]}`;
    req.requestId = requestId;

    // Log request details
    logger.info({
        requestId,
        method: req.method,
        url: req.url,
        path: req.path,
        query: req.query,
        body: sanitizeBody(req.body),
        headers: sanitizeHeaders(req.headers),
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.headers['user-agent']
    }, 'Incoming request');

    // Log response when it finishes
    const startTime = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        logger.info({
            requestId,
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            duration: `${duration}ms`
        }, 'Request completed');
    });

    next();
}

module.exports = requestLogger;

