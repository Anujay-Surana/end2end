/**
 * Multi-Account Fetcher Service
 *
 * Fetches emails, Drive files, and calendar events from MULTIPLE Google accounts in parallel.
 * This is the core of multi-account support - when a user prepares for a meeting,
 * we search ALL their connected accounts, not just the one where the meeting is scheduled.
 */

const { fetchGmailMessages, fetchDriveFiles, fetchDriveFileContents, fetchCalendarEvents } = require('./googleApi');

/**
 * Extract keywords from meeting title and description (ORIGINAL)
 */
function extractKeywords(title, description = '') {
    const text = `${title} ${description}`.toLowerCase();
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
                       'meeting', 'discussion', 'call', 'review', 'session', 'sync', 'chat', 'talk'];

    const words = text
        .split(/[\s\-_,\.;:()[\]{}]+/)
        .filter(w => w.length > 3 && !stopWords.includes(w))
        .filter(w => !/^\d+$/.test(w)); // Remove pure numbers

    // Return unique words, max 5
    return [...new Set(words)].slice(0, 5);
}

/**
 * Fetch emails from all connected accounts in parallel (ENHANCED WITH 2-YEAR LOOKBACK + KEYWORDS)
 * @param {Array} accounts - Array of account objects with access_token
 * @param {Array} attendees - Meeting attendees
 * @param {Object} meeting - Meeting object
 * @returns {Promise<Array>} - Array of results per account
 */
async function fetchEmailsFromAllAccounts(accounts, attendees, meeting) {
    console.log(`\n📧 Fetching emails from ${accounts.length} account(s) in parallel...`);

    // Extract keywords from meeting title for enhanced search (ORIGINAL FEATURE)
    // Handle Google Calendar format: meeting.summary or meeting.title
    const meetingTitle = meeting.summary || meeting.title || '';
    const keywords = extractKeywords(meetingTitle, meeting.description || '');
    console.log(`   🔑 Extracted keywords: ${keywords.join(', ')}`);

    // CRITICAL: 2-YEAR lookback (not 6 months) - working relationships span years
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const afterDate = twoYearsAgo.toISOString().split('T')[0].replace(/-/g, '/');
    console.log(`   📅 Searching emails from past 2 years (since ${afterDate})`);

    const results = await Promise.allSettled(
        accounts.map(async (account) => {
            try {
                console.log(`\n   Account: ${account.account_email}`);

                // Build enhanced Gmail search query with keywords and date filter
                const attendeeEmails = attendees
                    .map(a => a.email)
                    .filter(Boolean);

                // Handle empty attendees case
                if (attendeeEmails.length === 0) {
                    console.log('   ⚠️  No attendee emails provided, using keyword-only search');
                    // Build keyword-only query if keywords exist
                    if (keywords.length === 0) {
                        return {
                            accountEmail: account.account_email,
                            emails: [],
                            success: true
                        };
                    }
                    const keywordParts = keywords.slice(0, 3).map(k => `subject:"${k}" OR "${k}"`).join(' OR ');
                    const query = `(${keywordParts}) after:${afterDate}`;
                    const emails = await fetchGmailMessages(account, query, 100);
                    return {
                        accountEmail: account.account_email,
                        emails: emails,
                        success: true
                    };
                }

                const domains = [...new Set(attendeeEmails.map(e => e.split('@')[1]).filter(Boolean))];

                const attendeeQueries = attendeeEmails.map(email => `from:${email} OR to:${email}`).join(' OR ');
                const domainQueries = domains.length > 0 
                    ? domains.map(d => `from:*@${d}`).join(' OR ')
                    : '';

                // Add keyword search (ORIGINAL FEATURE)
                let keywordQuery = '';
                if (keywords.length > 0) {
                    const keywordParts = keywords.slice(0, 3).map(k => `subject:"${k}" OR "${k}"`).join(' OR ');
                    keywordQuery = ` OR (${keywordParts})`;
                }

                // Build query parts conditionally to avoid invalid syntax
                const queryParts = [];
                if (attendeeQueries) queryParts.push(`(${attendeeQueries})`);
                if (domainQueries) queryParts.push(`(${domainQueries})`);
                if (keywordQuery) queryParts.push(keywordQuery.replace(' OR ', '')); // Remove leading OR

                if (queryParts.length === 0) {
                    console.log('   ⚠️  No valid query parts to search');
                    return {
                        accountEmail: account.account_email,
                        emails: [],
                        success: true
                    };
                }

                const query = `${queryParts.join(' OR ')} after:${afterDate}`;

                // REMOVED CAP: Fetch up to 100 emails (will process ALL in batches later)
                const emails = await fetchGmailMessages(account, query, 100);

                console.log(`   ✅ Fetched ${emails.length} emails from ${account.account_email}`);

                return {
                    accountEmail: account.account_email,
                    emails: emails,
                    success: true
                };
            } catch (error) {
                console.error(`   ❌ Error fetching from ${account.account_email}:`, error.message);
                return {
                    accountEmail: account.account_email,
                    emails: [],
                    success: false,
                    error: error.message
                };
            }
        })
    );

    // Extract results from Promise.allSettled
    const finalResults = results.map((result, index) => {
        if (result.status === 'fulfilled') {
            return result.value;
        } else {
            return {
                accountEmail: accounts[index].account_email,
                emails: [],
                success: false,
                error: result.reason?.message || 'Unknown error'
            };
        }
    });

    const totalEmails = finalResults.reduce((sum, r) => sum + r.emails.length, 0);
    const successfulAccounts = finalResults.filter(r => r.success).length;
    const failedAccounts = finalResults.filter(r => !r.success);

    console.log(`\n✅ Total emails fetched from all accounts: ${totalEmails}`);
    
    if (failedAccounts.length > 0) {
        console.warn(`⚠️  ${failedAccounts.length} account(s) failed to fetch emails:`);
        failedAccounts.forEach(({ accountEmail, error }) => {
            console.warn(`   - ${accountEmail}: ${error || 'Unknown error'}`);
        });
    }

    return {
        results: finalResults,
        successfulAccounts,
        failedAccounts: failedAccounts.length,
        accountStats: finalResults.map(r => ({
            accountEmail: r.accountEmail,
            success: r.success,
            emailCount: r.emails?.length || 0,
            error: r.error || null
        }))
    };
}

/**
 * Fetch Drive files from all connected accounts in parallel (ENHANCED WITH DOMAIN-WIDE + KEYWORD SEARCH)
 * @param {Array} accounts - Array of account objects with access_token
 * @param {Array} attendees - Meeting attendees
 * @param {Object} meeting - Meeting object
 * @returns {Promise<Array>} - Array of results per account
 */
async function fetchFilesFromAllAccounts(accounts, attendees, meeting) {
    console.log(`\n📁 Fetching Drive files from ${accounts.length} account(s) in parallel...`);

    // Extract keywords for file search (ORIGINAL FEATURE)
    // Handle Google Calendar format: meeting.summary or meeting.title
    const meetingTitle = meeting.summary || meeting.title || '';
    const keywords = extractKeywords(meetingTitle, meeting.description || '');

    // 2-year lookback for files too
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const timeFilter = `and modifiedTime > '${twoYearsAgo.toISOString()}'`;

    const results = await Promise.allSettled(
        accounts.map(async (account) => {
            try {
                console.log(`\n   Account: ${account.account_email}`);

                // Build Drive search queries (ENHANCED)
                const attendeeEmails = attendees
                    .map(a => a.email)
                    .filter(Boolean);

                const domains = attendeeEmails
                    .map(email => {
                        const match = email.match(/@(.+)$/);
                        return match ? match[1] : null;
                    })
                    .filter(Boolean);

                const uniqueDomains = [...new Set(domains)];

                // Query 1: Files shared with attendees (permission-based)
                const permQueries = attendeeEmails.map(email => `'${email}' in readers or '${email}' in writers`).join(' or ');
                const permQuery = permQueries ? `(${permQueries}) ${timeFilter}` : null;

                // Query 2: Domain-wide file query (ORIGINAL FEATURE)
                // Search for files from attendee domains using fullText search
                const domainSearchTerms = [
                    ...uniqueDomains.map(d => d.split('.')[0]), // company names (e.g., "kordn8", "tonik")
                    ...attendees.map(a => a.name ? a.name.split(' ')[0] : null).filter(Boolean) // First names
                ].filter(Boolean);

                const domainQuery = domainSearchTerms.length > 0
                    ? `(${domainSearchTerms.map(term => `fullText contains '${term}'`).join(' or ')}) ${timeFilter}`
                    : null;

                // Query 3: Keyword-based files (ORIGINAL FEATURE)
                let nameQuery = null;
                if (keywords.length > 0) {
                    const nameKeywords = keywords.map(k => `name contains '${k}'`).join(' or ');
                    nameQuery = `(${nameKeywords}) ${timeFilter}`;
                }

                console.log(`     📁 Permission-based query`);
                console.log(`     🌐 Domain-wide query (searching: ${domainSearchTerms.slice(0, 3).join(', ')})`);
                console.log(`     🔑 Keyword query (${keywords.slice(0, 3).join(', ')})`);

                // Fetch files for all queries in parallel - REMOVED CAPS (200 per query type)
                const [permFiles, domainFiles, nameFiles] = await Promise.all([
                    permQuery ? fetchDriveFiles(account, permQuery, 200) : Promise.resolve([]),
                    domainQuery ? fetchDriveFiles(account, domainQuery, 200) : Promise.resolve([]),
                    nameQuery ? fetchDriveFiles(account, nameQuery, 200) : Promise.resolve([])
                ]);

                // Merge and deduplicate files by ID
                const allFiles = [...permFiles, ...domainFiles, ...nameFiles];
                const uniqueFiles = Array.from(
                    new Map(allFiles.map(file => [file.id, file])).values()
                );

                console.log(`     ✅ Found ${uniqueFiles.length} unique files`);
                console.log(`        - ${permFiles.length} from permissions`);
                console.log(`        - ${domainFiles.length} from domain-wide search`);
                console.log(`        - ${nameFiles.length} from keyword matching`);

                // Fetch file contents for ALL files (REMOVED 5-FILE CAP)
                const filesWithContent = await fetchDriveFileContents(account, uniqueFiles);

                return {
                    accountEmail: account.account_email,
                    files: filesWithContent,
                    success: true
                };
            } catch (error) {
                console.error(`   ❌ Error fetching from ${account.account_email}:`, error.message);
                return {
                    accountEmail: account.account_email,
                    files: [],
                    success: false,
                    error: error.message
                };
            }
        })
    );

    // Extract results from Promise.allSettled
    const finalResults = results.map((result, index) => {
        if (result.status === 'fulfilled') {
            return result.value;
        } else {
            return {
                accountEmail: accounts[index].account_email,
                files: [],
                success: false,
                error: result.reason?.message || 'Unknown error'
            };
        }
    });

    const totalFiles = finalResults.reduce((sum, r) => sum + r.files.length, 0);
    const successfulAccounts = finalResults.filter(r => r.success).length;
    const failedAccounts = finalResults.filter(r => !r.success);

    console.log(`\n✅ Total files fetched from all accounts: ${totalFiles}`);
    
    if (failedAccounts.length > 0) {
        console.warn(`⚠️  ${failedAccounts.length} account(s) failed to fetch files:`);
        failedAccounts.forEach(({ accountEmail, error }) => {
            console.warn(`   - ${accountEmail}: ${error || 'Unknown error'}`);
        });
    }

    return {
        results: finalResults,
        successfulAccounts,
        failedAccounts: failedAccounts.length,
        accountStats: finalResults.map(r => ({
            accountEmail: r.accountEmail,
            success: r.success,
            fileCount: r.files?.length || 0,
            error: r.error || null
        }))
    };
}

/**
 * Merge and deduplicate emails from multiple accounts
 * @param {Array} resultsPerAccount - Array of {accountEmail, emails, success} objects
 * @returns {Array} - Deduplicated array of emails with source account metadata
 */
function mergeAndDeduplicateEmails(resultsPerAccount) {
    const seen = new Set();
    const merged = [];

    for (const result of resultsPerAccount) {
        if (!result.success) continue;

        for (const email of result.emails) {
            // Use email ID for deduplication (Gmail message IDs are unique)
            const key = email.id;

            if (!seen.has(key)) {
                seen.add(key);
                // Add source account metadata
                merged.push({
                    ...email,
                    _sourceAccount: result.accountEmail
                });
            }
        }
    }

    console.log(`\n🔄 Deduplicated emails: ${merged.length} unique (from ${resultsPerAccount.reduce((sum, r) => sum + r.emails.length, 0)} total)`);

    return merged;
}

/**
 * Merge and deduplicate files from multiple accounts
 * @param {Array} resultsPerAccount - Array of {accountEmail, files, success} objects
 * @returns {Array} - Deduplicated array of files with source account metadata
 */
function mergeAndDeduplicateFiles(resultsPerAccount) {
    const seen = new Set();
    const merged = [];

    for (const result of resultsPerAccount) {
        if (!result.success) continue;

        for (const file of result.files) {
            // Use file ID for deduplication (Drive file IDs are unique)
            const key = file.id;

            if (!seen.has(key)) {
                seen.add(key);
                // Add source account metadata
                merged.push({
                    ...file,
                    _sourceAccount: result.accountEmail
                });
            }
        }
    }

    console.log(`\n🔄 Deduplicated files: ${merged.length} unique (from ${resultsPerAccount.reduce((sum, r) => sum + r.files.length, 0)} total)`);

    return merged;
}

/**
 * Fetch all context from multiple accounts (emails + files)
 * This is the main entry point for multi-account context gathering
 * @param {Array} accounts - Array of account objects with access_token
 * @param {Array} attendees - Meeting attendees
 * @param {Object} meeting - Meeting object
 * @returns {Promise<Object>} - { emails: Array, files: Array, accountStats: Object }
 */
async function fetchAllAccountContext(accounts, attendees, meeting) {
    console.log(`\n🚀 Starting multi-account context fetch for ${accounts.length} account(s)`);
    console.log(`   Accounts: ${accounts.map(a => a.account_email).join(', ')}`);

    const startTime = Date.now();

    // Fetch emails and files in parallel from ALL accounts
    const [emailResults, fileResults] = await Promise.all([
        fetchEmailsFromAllAccounts(accounts, attendees, meeting),
        fetchFilesFromAllAccounts(accounts, attendees, meeting)
    ]);

    // Extract results arrays (handle new return format)
    const emailResultsArray = Array.isArray(emailResults) ? emailResults : (emailResults.results || []);
    const fileResultsArray = Array.isArray(fileResults) ? fileResults : (fileResults.results || []);

    // Merge and deduplicate results
    const emails = mergeAndDeduplicateEmails(emailResultsArray);
    const files = mergeAndDeduplicateFiles(fileResultsArray);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Build statistics (handle new return format)
    const emailStats = emailResults.accountStats || emailResultsArray.map(r => ({
        account: r.accountEmail,
        count: r.emails?.length || 0,
        success: r.success
    }));
    const fileStats = fileResults.accountStats || fileResultsArray.map(r => ({
        account: r.accountEmail,
        count: r.files?.length || 0,
        success: r.success
    }));

    const accountStats = {
        totalAccounts: accounts.length,
        successfulAccounts: emailResults.successfulAccounts !== undefined 
            ? emailResults.successfulAccounts 
            : emailResultsArray.filter(r => r.success).length,
        failedAccounts: emailResults.failedAccounts !== undefined
            ? emailResults.failedAccounts
            : emailResultsArray.filter(r => !r.success).length,
        totalEmails: emails.length,
        totalFiles: files.length,
        emailsByAccount: emailStats,
        filesByAccount: fileStats,
        durationSeconds: parseFloat(duration),
        partialFailure: (emailResults.failedAccounts > 0 || fileResults.failedAccounts > 0) && 
                        (emailResults.successfulAccounts > 0 || fileResults.successfulAccounts > 0)
    };

    console.log(`\n✅ Multi-account fetch complete in ${duration}s`);
    console.log(`   📧 ${emails.length} emails, 📁 ${files.length} files`);

    return {
        emails,
        files,
        accountStats
    };
}

/**
 * Fetch calendar events from all connected accounts in parallel
 * Looks for past meetings with attendees from the current meeting
 * @param {Array} accounts - Array of account objects with access_token
 * @param {Array} attendees - Meeting attendees
 * @param {Object} meeting - Meeting object
 * @returns {Promise<Array>} - Array of results per account
 */
async function fetchCalendarFromAllAccounts(accounts, attendees, meeting) {
    console.log(`\n📅 Fetching calendar events from ${accounts.length} account(s) in parallel...`);

    // Search for past meetings with these attendees (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const timeMin = sixMonthsAgo.toISOString();
    const timeMax = new Date().toISOString();

    const results = await Promise.allSettled(
        accounts.map(async (account) => {
            try {
                console.log(`\n   Account: ${account.account_email}`);

                // Fetch all calendar events in the time range
                const events = await fetchCalendarEvents(account, timeMin, timeMax, 200);

                // Filter events that include any of the meeting attendees
                // Exclude the current meeting itself (if it has an ID)
                const attendeeEmails = attendees.map(a => a.email || a.emailAddress).filter(Boolean);
                const currentMeetingId = meeting.id;
                const relevantEvents = events.filter(event => {
                    // Skip if this is the current meeting
                    if (currentMeetingId && event.id === currentMeetingId) {
                        return false;
                    }
                    // Only include past events (before current meeting or before now)
                    const eventStart = event.start?.dateTime || event.start?.date;
                    if (eventStart) {
                        const eventDate = new Date(eventStart);
                        const meetingStart = meeting.start?.dateTime || meeting.start?.date || meeting.start;
                        const meetingDate = meetingStart ? new Date(meetingStart) : new Date();
                        // Only include events that happened before the current meeting
                        if (eventDate >= meetingDate) {
                            return false;
                        }
                    }
                    // Check if event includes any attendees
                    const eventAttendees = (event.attendees || []).map(a => a.email || a.emailAddress).filter(Boolean);
                    return attendeeEmails.some(email => eventAttendees.includes(email));
                });

                console.log(`   ✅ Found ${relevantEvents.length} relevant past meetings from ${account.account_email}`);

                return {
                    accountEmail: account.account_email,
                    events: relevantEvents,
                    success: true
                };
            } catch (error) {
                console.error(`   ❌ Error fetching calendar from ${account.account_email}:`, error.message);
                return {
                    accountEmail: account.account_email,
                    events: [],
                    success: false,
                    error: error.message
                };
            }
        })
    );

    // Extract results from Promise.allSettled
    const finalResults = results.map((result, index) => {
        if (result.status === 'fulfilled') {
            return result.value;
        } else {
            return {
                accountEmail: accounts[index].account_email,
                events: [],
                success: false,
                error: result.reason?.message || 'Unknown error'
            };
        }
    });

    const totalEvents = finalResults.reduce((sum, r) => sum + r.events.length, 0);
    const successfulAccounts = finalResults.filter(r => r.success).length;
    const failedAccounts = finalResults.filter(r => !r.success);

    console.log(`\n✅ Total calendar events fetched from all accounts: ${totalEvents}`);
    
    if (failedAccounts.length > 0) {
        console.warn(`⚠️  ${failedAccounts.length} account(s) failed to fetch calendar events:`);
        failedAccounts.forEach(({ accountEmail, error }) => {
            console.warn(`   - ${accountEmail}: ${error || 'Unknown error'}`);
        });
    }

    return {
        results: finalResults,
        successfulAccounts,
        failedAccounts: failedAccounts.length
    };
}

/**
 * Merge and deduplicate calendar events from multiple accounts
 * @param {Array} resultsPerAccount - Array of {accountEmail, events, success} objects
 * @returns {Array} - Deduplicated array of events with source account metadata
 */
function mergeAndDeduplicateCalendarEvents(resultsPerAccount) {
    const seen = new Set();
    const merged = [];

    for (const result of resultsPerAccount) {
        if (!result.success) continue;

        for (const event of result.events) {
            // Use event ID for deduplication (Calendar event IDs are unique)
            const key = event.id;

            if (!seen.has(key)) {
                seen.add(key);
                // Add source account metadata
                merged.push({
                    ...event,
                    _sourceAccount: result.accountEmail
                });
            }
        }
    }

    console.log(`\n🔄 Deduplicated events: ${merged.length} unique (from ${resultsPerAccount.reduce((sum, r) => sum + r.events.length, 0)} total)`);

    return merged;
}

module.exports = {
    fetchEmailsFromAllAccounts,
    fetchFilesFromAllAccounts,
    mergeAndDeduplicateEmails,
    mergeAndDeduplicateFiles,
    fetchAllAccountContext,
    fetchCalendarFromAllAccounts,
    mergeAndDeduplicateCalendarEvents
};
