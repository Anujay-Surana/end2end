/**
 * Day Prep Routes
 *
 * Handles day prep requests - fetches all meetings for a day and prepares comprehensive day prep brief
 */

const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../middleware/auth');
const { getAccountsByUserId } = require('../db/queries/accounts');
const { ensureAllTokensValid } = require('../services/tokenRefresh');
const { fetchCalendarEvents } = require('../services/googleApi');
const { callGPT } = require('../services/gptService');
const logger = require('../services/logger');

/**
 * GET /api/meetings-for-day
 * Get all meetings for a specific day
 */
router.get('/meetings-for-day', optionalAuth, async (req, res) => {
    const requestId = req.requestId || 'unknown';
    const { date } = req.query;

    if (!date) {
        return res.status(400).json({
            error: 'ValidationError',
            message: 'Date parameter is required',
            field: 'date',
            received: date,
            expected: 'YYYY-MM-DD format',
            requestId
        });
    }

    try {
        logger.info({ requestId, date }, 'Fetching meetings for day');

        // Parse date string (YYYY-MM-DD) - create date at midnight in local timezone to avoid UTC shift
        const [year, month, day] = date.split('-').map(Number);
        if (!year || !month || !day || isNaN(year) || isNaN(month) || isNaN(day)) {
            return res.status(400).json({
                error: 'ValidationError',
                message: 'Invalid date format',
                field: 'date',
                received: date,
                expected: 'YYYY-MM-DD format',
                requestId
            });
        }
        const selectedDate = new Date(year, month - 1, day); // month is 0-indexed, creates date in local timezone

        // Set time boundaries for the day (already at midnight local time)
        const startOfDay = new Date(selectedDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(selectedDate);
        endOfDay.setHours(23, 59, 59, 999);

        let allMeetings = [];

        // Multi-account mode
        if (req.userId) {
            const accounts = await getAccountsByUserId(req.userId);
            
            if (accounts.length === 0) {
                return res.json({ meetings: [] });
            }

            // Validate tokens
            const { validAccounts, failedAccounts } = await ensureAllTokensValid(accounts);
            
            if (validAccounts.length === 0) {
                // Check if all failures are due to revoked tokens
                const allRevoked = failedAccounts.every(f => f.isRevoked);
                
                return res.status(401).json({
                    error: allRevoked ? 'TokenRevoked' : 'AuthenticationError',
                    message: allRevoked 
                        ? 'Your session has expired. Please sign in again.'
                        : 'All accounts need to re-authenticate',
                    revoked: allRevoked,
                    failedAccounts: failedAccounts.map(a => ({ 
                        email: a.account_email, 
                        reason: a.isRevoked ? 'Token revoked' : 'Token expired',
                        isRevoked: a.isRevoked
                    })),
                    requestId
                });
            }

            // Fetch meetings from all accounts in parallel
            const meetingPromises = validAccounts.map(async (account) => {
                try {
                    const events = await fetchCalendarEvents(account, startOfDay.toISOString(), endOfDay.toISOString(), 100);
                    return events.map(event => ({
                        ...event,
                        accountEmail: account.account_email
                    }));
                } catch (error) {
                    logger.error({ requestId, accountEmail: account.account_email, error: error.message }, 'Error fetching meetings for day');
                    return [];
                }
            });

            const meetingArrays = await Promise.all(meetingPromises);
            allMeetings = meetingArrays.flat();

        } else {
            // Single-account mode (backward compatibility)
            const accessToken = req.headers.authorization?.replace('Bearer ', '');
            if (!accessToken) {
                return res.status(401).json({
                    error: 'AuthenticationError',
                    message: 'Access token required',
                    requestId
                });
            }

            const events = await fetchCalendarEvents(accessToken, startOfDay.toISOString(), endOfDay.toISOString(), 100);
            allMeetings = events;
        }

        // Sort by start time
        allMeetings.sort((a, b) => {
            const timeA = new Date(a.start?.dateTime || a.start?.date || a.start || 0);
            const timeB = new Date(b.start?.dateTime || b.start?.date || b.start || 0);
            return timeA - timeB;
        });

        logger.info({ requestId, date, meetingCount: allMeetings.length }, 'Meetings fetched for day');

        res.json({ meetings: allMeetings });

    } catch (error) {
        logger.error({ requestId, error: error.message, stack: error.stack, date }, 'Error fetching meetings for day');
        res.status(500).json({
            error: 'ServerError',
            message: 'Failed to fetch meetings for day',
            requestId
        });
    }
});

/**
 * POST /api/day-prep
 * Prepare comprehensive day prep for all meetings on a specific day
 */
router.post('/day-prep', optionalAuth, async (req, res) => {
    const requestId = req.requestId || 'unknown';
    const { date } = req.body;

    if (!date) {
        return res.status(400).json({
            error: 'ValidationError',
            message: 'Date is required',
            field: 'date',
            received: date,
            expected: 'YYYY-MM-DD format',
            requestId
        });
    }

    try {
        logger.info({ requestId, date }, 'Starting day prep');

        // Parse date
        const selectedDate = new Date(date);
        if (isNaN(selectedDate.getTime())) {
            return res.status(400).json({
                error: 'ValidationError',
                message: 'Invalid date format',
                field: 'date',
                received: date,
                expected: 'YYYY-MM-DD format',
                requestId
            });
        }

        // Set time boundaries for the day
        const startOfDay = new Date(selectedDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(selectedDate);
        endOfDay.setHours(23, 59, 59, 999);

        // Fetch meetings for the day (reuse meetings-for-day logic)
        let allMeetings = [];

        if (req.userId) {
            const accounts = await getAccountsByUserId(req.userId);
            
            if (accounts.length === 0) {
                return res.status(401).json({
                    error: 'AuthenticationError',
                    message: 'No connected accounts',
                    requestId
                });
            }

            const { validAccounts } = await ensureAllTokensValid(accounts);
            
            if (validAccounts.length === 0) {
                return res.status(401).json({
                    error: 'AuthenticationError',
                    message: 'All accounts need to re-authenticate',
                    requestId
                });
            }

            const meetingPromises = validAccounts.map(async (account) => {
                try {
                    const events = await fetchCalendarEvents(account, startOfDay.toISOString(), endOfDay.toISOString(), 100);
                    return events;
                } catch (error) {
                    logger.error({ requestId, accountEmail: account.account_email, error: error.message }, 'Error fetching meetings for day prep');
                    return [];
                }
            });

            const meetingArrays = await Promise.all(meetingPromises);
            allMeetings = meetingArrays.flat();

        } else {
            return res.status(401).json({
                error: 'AuthenticationError',
                message: 'Authentication required for day prep',
                requestId
            });
        }

        if (allMeetings.length === 0) {
            // Format date correctly (handle timezone)
            const dateAtMidnight = new Date(Date.UTC(
                selectedDate.getFullYear(),
                selectedDate.getMonth(),
                selectedDate.getDate()
            ));
            const dateStr = dateAtMidnight.toLocaleDateString('en-US', { 
                weekday: 'long', 
                year: 'numeric', 
                month: 'long', 
                day: 'numeric',
                timeZone: 'UTC'
            });
            
            return res.json({
                date: date,
                meetings: [],
                dayPrep: {
                    summary: `No meetings scheduled for ${dateStr}.`,
                    narrative: `You have no meetings scheduled for this day.`
                }
            });
        }

        // Sort meetings by time
        allMeetings.sort((a, b) => {
            const timeA = new Date(a.start?.dateTime || a.start?.date || a.start || 0);
            const timeB = new Date(b.start?.dateTime || b.start?.date || b.start || 0);
            return timeA - timeB;
        });

        logger.info({ requestId, date, meetingCount: allMeetings.length }, 'Preparing day prep for meetings');

        // Run meeting prep on all meetings in PARALLEL
        // Make internal HTTP calls to prep-meeting endpoint
        const prepPromises = allMeetings.map(async (meeting) => {
            try {
                // Make internal HTTP call to prep-meeting endpoint
                const http = require('http');
                const prepMeetingData = JSON.stringify({
                    meeting: meeting,
                    attendees: meeting.attendees || []
                });

                const options = {
                    hostname: 'localhost',
                    port: process.env.PORT || 8080,
                    path: '/api/prep-meeting',
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(prepMeetingData),
                        'Cookie': req.headers.cookie || ''
                    }
                };

                return new Promise((resolve, reject) => {
                    const reqHttp = http.request(options, (resHttp) => {
                        let data = '';
                        resHttp.on('data', (chunk) => { data += chunk; });
                        resHttp.on('end', () => {
                            if (resHttp.statusCode >= 200 && resHttp.statusCode < 300) {
                                try {
                                    const brief = JSON.parse(data);
                                    resolve({ meeting, brief, success: true });
                                } catch (parseError) {
                                    reject(new Error(`Failed to parse prep-meeting response: ${parseError.message}`));
                                }
                            } else {
                                reject(new Error(`Prep meeting failed: ${resHttp.statusCode} - ${data.substring(0, 200)}`));
                            }
                        });
                    });

                    reqHttp.on('error', (error) => {
                        reject(new Error(`Prep meeting request failed: ${error.message}`));
                    });

                    reqHttp.write(prepMeetingData);
                    reqHttp.end();
                });
            } catch (error) {
                logger.error({ requestId, meetingId: meeting.id, error: error.message }, 'Error preparing meeting for day prep');
                return { meeting, brief: null, success: false, error: error.message };
            }
        });

        const prepResults = await Promise.all(prepPromises);
        const successfulPreps = prepResults.filter(r => r.success && r.brief);

        logger.info({ requestId, totalMeetings: allMeetings.length, successfulPreps: successfulPreps.length }, 'Day prep meetings prepared');

        // Synthesize day prep using Shadow persona
        const dayPrepSynthesizer = require('../services/dayPrepSynthesizer');
        const dayPrep = await dayPrepSynthesizer.synthesizeDayPrep(
            selectedDate,
            allMeetings,
            successfulPreps.map(r => r.brief),
            requestId,
            req // Pass request for user context
        );

        res.json({
            date: date,
            meetings: allMeetings.map(m => ({
                id: m.id,
                summary: m.summary || m.title,
                start: m.start,
                attendees: m.attendees || []
            })),
            prepResults: prepResults.map(r => ({
                meetingId: r.meeting.id,
                success: r.success,
                error: r.error
            })),
            dayPrep: dayPrep
        });

    } catch (error) {
        logger.error({ requestId, error: error.message, stack: error.stack, date }, 'Error preparing day prep');
        res.status(500).json({
            error: 'ServerError',
            message: 'Failed to prepare day prep',
            requestId
        });
    }
});

module.exports = router;

