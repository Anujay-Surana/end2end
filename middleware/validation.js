/**
 * Input Validation Middleware
 *
 * Validates request bodies and parameters for API endpoints
 */

const logger = require('../services/logger');

/**
 * Create detailed validation error response
 */
function createValidationError(field, received, expected, message, requestId) {
    const error = {
        error: 'ValidationError',
        message: message,
        field: field,
        received: received,
        expected: expected,
        requestId: requestId
    };
    return error;
}

/**
 * Validate meeting prep request body
 */
function validateMeetingPrep(req, res, next) {
    const { meeting, attendees, accessToken, includeCalendar } = req.body;
    const requestId = req.requestId || 'unknown';

    // Meeting object validation
    if (!meeting || typeof meeting !== 'object') {
        logger.warn({
            requestId,
            validationError: 'meeting_object_missing',
            received: typeof meeting,
            bodyKeys: Object.keys(req.body || {})
        }, 'Validation failed: meeting object missing or invalid');

        return res.status(400).json(createValidationError(
            'meeting',
            typeof meeting,
            'object',
            'Meeting object is required',
            requestId
        ));
    }

    // Google Calendar format: meeting.summary or meeting.title
    const meetingTitle = meeting.summary || meeting.title;
    if (!meetingTitle || typeof meetingTitle !== 'string' || meetingTitle.trim().length === 0) {
        logger.warn({
            requestId,
            validationError: 'meeting_title_missing',
            meetingKeys: Object.keys(meeting),
            summary: meeting.summary ? typeof meeting.summary : 'missing',
            title: meeting.title ? typeof meeting.title : 'missing'
        }, 'Validation failed: meeting summary or title is required');

        return res.status(400).json(createValidationError(
            'meeting.summary',
            meeting.summary || meeting.title || null,
            'string (non-empty)',
            'Meeting summary or title is required',
            requestId
        ));
    }

    // Validate meeting has date/time if provided (for calendar queries)
    // Google Calendar format: meeting.start.dateTime or meeting.start.date
    if (meeting.start) {
        if (typeof meeting.start === 'object') {
            // Google Calendar format: { dateTime: "2024-01-01T10:00:00Z" } or { date: "2024-01-01" }
            const startValue = meeting.start.dateTime || meeting.start.date;
            if (startValue) {
                const startDate = new Date(startValue);
                if (isNaN(startDate.getTime())) {
                    logger.warn({
                        requestId,
                        validationError: 'invalid_start_date',
                        received: startValue
                    }, 'Validation failed: invalid meeting start date');

                    return res.status(400).json(createValidationError(
                        'meeting.start',
                        startValue,
                        'valid ISO date string',
                        'Meeting start time must be a valid date',
                        requestId
                    ));
                }
            }
        } else if (typeof meeting.start === 'string') {
            // Simple string format
            const startDate = new Date(meeting.start);
            if (isNaN(startDate.getTime())) {
                logger.warn({
                    requestId,
                    validationError: 'invalid_start_date_string',
                    received: meeting.start
                }, 'Validation failed: invalid meeting start date string');

                return res.status(400).json(createValidationError(
                    'meeting.start',
                    meeting.start,
                    'valid date string',
                    'Meeting start time must be a valid date',
                    requestId
                ));
            }
        }
    }

    if (meeting.date) {
        const date = new Date(meeting.date);
        if (isNaN(date.getTime())) {
            logger.warn({
                requestId,
                validationError: 'invalid_date',
                received: meeting.date
            }, 'Validation failed: invalid meeting date');

            return res.status(400).json(createValidationError(
                'meeting.date',
                meeting.date,
                'valid date string',
                'Meeting date must be a valid date',
                requestId
            ));
        }
    }

    // Validate description if provided
    if (meeting.description !== undefined && typeof meeting.description !== 'string') {
        logger.warn({
            requestId,
            validationError: 'invalid_description',
            received: typeof meeting.description
        }, 'Validation failed: meeting description must be string');

        return res.status(400).json(createValidationError(
            'meeting.description',
            typeof meeting.description,
            'string',
            'Meeting description must be a string',
            requestId
        ));
    }

    // Attendees validation (optional but must be array if provided)
    if (attendees !== undefined) {
        if (!Array.isArray(attendees)) {
            logger.warn({
                requestId,
                validationError: 'attendees_not_array',
                received: typeof attendees
            }, 'Validation failed: attendees must be array');

            return res.status(400).json(createValidationError(
                'attendees',
                typeof attendees,
                'array',
                'Attendees must be an array',
                requestId
            ));
        }

        // Validate each attendee has email
        for (let i = 0; i < attendees.length; i++) {
            const attendee = attendees[i];
            if (!attendee || typeof attendee !== 'object') {
                logger.warn({
                    requestId,
                    validationError: 'attendee_not_object',
                    index: i,
                    received: typeof attendee
                }, 'Validation failed: attendee must be object');

                return res.status(400).json(createValidationError(
                    `attendees[${i}]`,
                    typeof attendee,
                    'object',
                    `Attendee at index ${i} must be an object`,
                    requestId
                ));
            }
            // Google Calendar attendees might have email in different formats
            // Accept either attendee.email or attendee.emailAddress
            const email = attendee.email || attendee.emailAddress;
            if (!email || typeof email !== 'string') {
                // Skip resource calendars (conference rooms) - they don't need email validation
                if (email && email.includes('@resource.calendar.google.com')) {
                    continue; // Skip this attendee
                }
                logger.warn({
                    requestId,
                    validationError: 'attendee_missing_email',
                    index: i,
                    attendee: attendee
                }, 'Validation failed: attendee missing email');

                return res.status(400).json(createValidationError(
                    `attendees[${i}].email`,
                    email || null,
                    'string (email address)',
                    `Attendee at index ${i} must have a valid email property`,
                    requestId
                ));
            }
        }
    }

    // includeCalendar validation (optional boolean)
    if (includeCalendar !== undefined && typeof includeCalendar !== 'boolean') {
        logger.warn({
            requestId,
            validationError: 'invalid_includeCalendar',
            received: typeof includeCalendar
        }, 'Validation failed: includeCalendar must be boolean');

        return res.status(400).json(createValidationError(
            'includeCalendar',
            typeof includeCalendar,
            'boolean',
            'includeCalendar must be a boolean',
            requestId
        ));
    }

    // accessToken validation (optional string, for backward compatibility)
    if (accessToken !== undefined && typeof accessToken !== 'string') {
        logger.warn({
            requestId,
            validationError: 'invalid_accessToken',
            received: typeof accessToken
        }, 'Validation failed: accessToken must be string');

        return res.status(400).json(createValidationError(
            'accessToken',
            typeof accessToken,
            'string',
            'accessToken must be a string',
            requestId
        ));
    }

    logger.debug({ requestId }, 'Validation passed for meeting prep request');
    next();
}

/**
 * Validate OAuth callback request body
 */
function validateOAuthCallback(req, res, next) {
    const { code } = req.body;

    if (!code || typeof code !== 'string' || code.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Authorization code is required'
        });
    }

    // Basic validation: OAuth codes are typically base64-like strings
    if (code.length < 20 || code.length > 2000) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Authorization code format is invalid'
        });
    }

    next();
}

/**
 * Validate parallel search request body
 */
function validateParallelSearch(req, res, next) {
    const { objective, search_queries, mode, max_results, max_chars_per_result } = req.body;

    if (!objective || typeof objective !== 'string' || objective.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Search objective is required'
        });
    }

    if (objective.length > 1000) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Search objective is too long (max 1000 characters)'
        });
    }

    // search_queries validation (optional but must be array if provided)
    if (search_queries !== undefined) {
        if (!Array.isArray(search_queries)) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'search_queries must be an array'
            });
        }

        if (search_queries.length === 0 || search_queries.length > 10) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'search_queries must contain 1-10 queries'
            });
        }

        for (let i = 0; i < search_queries.length; i++) {
            const query = search_queries[i];
            if (typeof query !== 'string' || query.trim().length === 0) {
                return res.status(400).json({
                    error: 'Invalid request',
                    message: `Search query at index ${i} must be a non-empty string`
                });
            }
            if (query.length > 500) {
                return res.status(400).json({
                    error: 'Invalid request',
                    message: `Search query at index ${i} is too long (max 500 characters)`
                });
            }
        }
    }

    // Optional parameters validation
    if (mode !== undefined && typeof mode !== 'string') {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'mode must be a string'
        });
    }

    if (max_results !== undefined) {
        if (typeof max_results !== 'number' || max_results < 1 || max_results > 50) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'max_results must be a number between 1 and 50'
            });
        }
    }

    if (max_chars_per_result !== undefined) {
        if (typeof max_chars_per_result !== 'number' || max_chars_per_result < 100 || max_chars_per_result > 10000) {
            return res.status(400).json({
                error: 'Invalid request',
                message: 'max_chars_per_result must be a number between 100 and 10000'
            });
        }
    }

    next();
}

/**
 * Validate parallel extract request body
 */
function validateParallelExtract(req, res, next) {
    const { urls, objective, excerpts, fullContent } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'URLs array is required and must not be empty'
        });
    }

    if (urls.length > 20) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Maximum 20 URLs allowed per request'
        });
    }

    // Validate each URL
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (typeof url !== 'string' || url.trim().length === 0) {
            return res.status(400).json({
                error: 'Invalid request',
                message: `URL at index ${i} must be a non-empty string`
            });
        }

        // Basic URL format validation
        try {
            new URL(url);
        } catch (e) {
            return res.status(400).json({
                error: 'Invalid request',
                message: `URL at index ${i} is not a valid URL`
            });
        }
    }

    // Optional parameters
    if (objective !== undefined && (typeof objective !== 'string' || objective.length > 500)) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'objective must be a string (max 500 characters)'
        });
    }

    if (excerpts !== undefined && typeof excerpts !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'excerpts must be a boolean'
        });
    }

    if (fullContent !== undefined && typeof fullContent !== 'boolean') {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'fullContent must be a boolean'
        });
    }

    next();
}

/**
 * Validate TTS request body
 */
function validateTTS(req, res, next) {
    const { text } = req.body;

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Text is required'
        });
    }

    if (text.length > 4096) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Text is too long (max 4096 characters)'
        });
    }

    next();
}

/**
 * Validate account ID parameter
 */
function validateAccountId(req, res, next) {
    const { accountId } = req.params;

    if (!accountId || typeof accountId !== 'string') {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Account ID is required'
        });
    }

    // Basic UUID format validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(accountId)) {
        return res.status(400).json({
            error: 'Invalid request',
            message: 'Account ID must be a valid UUID'
        });
    }

    next();
}

module.exports = {
    validateMeetingPrep,
    validateOAuthCallback,
    validateParallelSearch,
    validateParallelExtract,
    validateTTS,
    validateAccountId
};

