/**
 * Rate Limiting Middleware
 *
 * Protects expensive endpoints from abuse and DDoS attacks
 */

const rateLimit = require('express-rate-limit');

/**
 * General API rate limiter - applies to most endpoints
 * 100 requests per 15 minutes per IP
 */
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: {
        error: 'Too many requests',
        message: 'Too many requests from this IP, please try again later.'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

/**
 * Strict rate limiter for expensive AI endpoints
 * 10 requests per hour per IP for meeting prep
 */
const meetingPrepLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // Limit each IP to 10 requests per hour
    message: {
        error: 'Rate limit exceeded',
        message: 'Too many meeting prep requests. Please wait before trying again.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: false, // Count all requests, even successful ones
});

/**
 * Moderate rate limiter for Parallel AI endpoints
 * 50 requests per 15 minutes per IP
 */
const parallelAILimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // Limit each IP to 50 requests per windowMs
    message: {
        error: 'Rate limit exceeded',
        message: 'Too many Parallel AI requests. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * Auth rate limiter - prevents brute force attacks
 * 5 requests per 15 minutes per IP
 */
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // Limit each IP to 5 auth requests per windowMs
    message: {
        error: 'Too many authentication attempts',
        message: 'Too many authentication attempts from this IP, please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // Don't count successful auth attempts
});

/**
 * TTS rate limiter - prevents audio generation abuse
 * 30 requests per 15 minutes per IP
 */
const ttsLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // Limit each IP to 30 TTS requests per windowMs
    message: {
        error: 'Rate limit exceeded',
        message: 'Too many TTS requests. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = {
    generalLimiter,
    meetingPrepLimiter,
    parallelAILimiter,
    authLimiter,
    ttsLimiter
};

