/**
 * Google API Service
 *
 * Centralized functions for interacting with Google APIs:
 * - Gmail API (fetch emails)
 * - Drive API (fetch files and content)
 * - Calendar API (fetch events)
 */

const { fetchWithRetry } = require('./googleApiRetry');
const { ensureValidToken } = require('./tokenRefresh');

/**
 * Fetch Gmail messages using query with automatic token refresh on 401
 * @param {string|Object} accessTokenOrAccount - Google OAuth access token (string) or account object with token refresh capability
 * @param {string} query - Gmail search query
 * @param {number} maxResults - Maximum number of messages to fetch
 * @returns {Promise<Array>} - Array of parsed email messages
 */
async function fetchGmailMessages(accessTokenOrAccount, query, maxResults = 100) {
    // Support both token string (backward compatibility) and account object (new)
    const isAccountObject = typeof accessTokenOrAccount === 'object' && accessTokenOrAccount !== null;
    let accessToken = isAccountObject ? accessTokenOrAccount.access_token : accessTokenOrAccount;
    let account = isAccountObject ? accessTokenOrAccount : null;
    try {
        console.log(`  📧 Gmail query: ${query.substring(0, 150)}...`);

        // Step 1: Get message IDs (with retry logic)
        const listResponse = await fetchWithRetry(
            `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            }
        );

        if (!listResponse.ok) {
            // If 401 and we have account object, try refreshing token once
            if (listResponse.status === 401 && account) {
                console.log(`  🔄 401 error detected, attempting token refresh for ${account.account_email}...`);
                try {
                    const refreshedAccount = await ensureValidToken(account);
                    accessToken = refreshedAccount.access_token;
                    account = refreshedAccount; // Update account reference
                    
                    // Retry the request with refreshed token
                    const retryResponse = await fetchWithRetry(
                        `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
                        {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        }
                    );
                    
                    if (!retryResponse.ok) {
                        throw new Error(`Gmail API error after token refresh: ${retryResponse.status}`);
                    }
                    
                    // Use retry response
                    const retryData = await retryResponse.json();
                    const messageIds = retryData.messages || [];
                    console.log(`  ✓ Found ${messageIds.length} message IDs (after token refresh)`);
                    
                    if (messageIds.length === 0) {
                        return [];
                    }
                    
                    // Continue with message fetching using refreshed token
                    // Update the function to use refreshed token for subsequent calls
                    return await fetchGmailMessagesWithToken(accessToken, messageIds, maxResults, account);
                } catch (refreshError) {
                    // Check if refresh token is revoked
                    if (refreshError.message.includes('REVOKED_TOKEN') || refreshError.message.includes('invalid_grant')) {
                        console.error(`  ❌ Token refresh failed - refresh token revoked for ${account.account_email}`);
                        throw new Error(`REVOKED_TOKEN: Account ${account.account_email} needs to re-authenticate. Refresh token has been revoked.`);
                    }
                    console.error(`  ❌ Token refresh failed for ${account.account_email}:`, refreshError.message);
                    throw new Error(`Gmail API error: ${listResponse.status} (token refresh failed: ${refreshError.message})`);
                }
            }
            throw new Error(`Gmail API error: ${listResponse.status}`);
        }

        const listData = await listResponse.json();
        const messageIds = listData.messages || [];

        console.log(`  ✓ Found ${messageIds.length} message IDs`);

        if (messageIds.length === 0) {
            return [];
        }

        // Step 2: Fetch full message details
        return await fetchGmailMessagesWithToken(accessToken, messageIds, maxResults, account);
    } catch (error) {
        console.error(`  ❌ Error fetching Gmail messages: ${error.message}`);
        throw error;
    }
}

/**
 * Helper function to fetch message details with token (supports refresh retry)
 */
async function fetchGmailMessagesWithToken(accessToken, messageIds, maxResults, account = null) {
    try {
        // Process in batches of 20 to avoid rate limits
        console.log(`  📧 Fetching full details for ALL ${messageIds.length} messages (batches of 20)...`);
        const allMessages = [];

        for (let i = 0; i < messageIds.length; i += 20) {
            const batch = messageIds.slice(i, i + 20);
            console.log(`     Processing email batch ${Math.floor(i / 20) + 1}/${Math.ceil(messageIds.length / 20)} (${batch.length} emails)...`);

            const batchPromises = batch.map(async (msg) => {
                try {
                    let msgResponse = await fetchWithRetry(
                        `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
                        {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        }
                    );
                    
                    // Handle 401 with token refresh
                    if (!msgResponse.ok && msgResponse.status === 401 && account) {
                        console.log(`  🔄 401 on message fetch, refreshing token...`);
                        const refreshedAccount = await ensureValidToken(account);
                        accessToken = refreshedAccount.access_token;
                        account = refreshedAccount;
                        
                        // Retry with refreshed token
                        msgResponse = await fetchWithRetry(
                            `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
                            {
                                headers: { 'Authorization': `Bearer ${accessToken}` }
                            }
                        );
                    }

                    if (!msgResponse.ok) {
                        return null;
                    }

                    return msgResponse.json();
                } catch (error) {
                    console.error(`  ⚠️  Error fetching message ${msg.id}:`, error.message);
                    return null;
                }
            });

            const batchMessages = (await Promise.all(batchPromises)).filter(Boolean);
            allMessages.push(...batchMessages);
        }

        const messages = allMessages;
        console.log(`  ✓ Fetched ${messages.length}/${messageIds.length} full messages`);

        // Step 3: Parse and format messages
        return messages.map(msg => {
            const headers = msg.payload?.headers || [];
            const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

            let body = '';
            let attachments = [];
            
            // Extract body and attachments from email parts
            if (msg.payload?.parts) {
                msg.payload.parts.forEach(part => {
                    // Check for text content
                    if (part.mimeType === 'text/plain' && part.body?.data) {
                        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                    }
                    // Check for attachments
                    if (part.filename && part.body?.attachmentId) {
                        attachments.push({
                            filename: part.filename,
                            mimeType: part.mimeType,
                            size: part.body.size,
                            attachmentId: part.body.attachmentId
                        });
                    }
                    // Check nested parts (multipart messages)
                    if (part.parts) {
                        part.parts.forEach(subPart => {
                            if (subPart.filename && subPart.body?.attachmentId) {
                                attachments.push({
                                    filename: subPart.filename,
                                    mimeType: subPart.mimeType,
                                    size: subPart.body.size,
                                    attachmentId: subPart.body.attachmentId
                                });
                            }
                        });
                    }
                });
            } else if (msg.payload?.body?.data) {
                body = Buffer.from(msg.payload.body.data, 'base64').toString('utf-8');
            }

            // Preserve full email body (up to 50k chars for very long emails)
            // Truncation will be applied later when needed for GPT calls
            const fullBody = body.length > 50000 ? body.substring(0, 50000) + '\n\n[Email truncated - showing first 50k chars]' : body;
            
            return {
                id: msg.id,
                subject: getHeader('Subject'),
                from: getHeader('From'),
                to: getHeader('To'),
                date: getHeader('Date'),
                snippet: msg.snippet || '',
                body: fullBody, // Full body preserved for filtering decisions
                attachments: attachments.length > 0 ? attachments : undefined // Include attachment metadata
            };
        });
    } catch (error) {
        console.error('  ❌ Error fetching Gmail messages:', error.message);
        return [];
    }
}

/**
 * Fetch Google Drive files using query with automatic token refresh on 401
 * @param {string|Object} accessTokenOrAccount - Google OAuth access token (string) or account object
 * @param {string} query - Drive search query
 * @param {number} maxResults - Maximum number of files to fetch
 * @returns {Promise<Array>} - Array of file metadata
 */
async function fetchDriveFiles(accessTokenOrAccount, query, maxResults = 50) {
    const isAccountObject = typeof accessTokenOrAccount === 'object' && accessTokenOrAccount !== null;
    let accessToken = isAccountObject ? accessTokenOrAccount.access_token : accessTokenOrAccount;
    let account = isAccountObject ? accessTokenOrAccount : null;
    try {
        console.log(`  📁 Drive query: ${query.substring(0, 150)}...`);

        const response = await fetchWithRetry(
            `https://www.googleapis.com/drive/v3/files?` +
            `q=${encodeURIComponent(query)}&` +
            `fields=files(id,name,mimeType,modifiedTime,owners,size,webViewLink,iconLink)&` +
            `orderBy=modifiedTime desc&` +
            `pageSize=${maxResults}`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            }
        );

        if (!response.ok) {
            // If 401 and we have account object, try refreshing token once
            if (response.status === 401 && account) {
                console.log(`  🔄 401 error detected, attempting token refresh for ${account.account_email}...`);
                try {
                    const refreshedAccount = await ensureValidToken(account);
                    accessToken = refreshedAccount.access_token;
                    account = refreshedAccount;
                    
                    // Retry the request with refreshed token
                    const retryResponse = await fetchWithRetry(
                        `https://www.googleapis.com/drive/v3/files?` +
                        `q=${encodeURIComponent(query)}&` +
                        `fields=files(id,name,mimeType,modifiedTime,owners,size,webViewLink,iconLink)&` +
                        `orderBy=modifiedTime desc&` +
                        `pageSize=${maxResults}`,
                        {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        }
                    );
                    
                    if (!retryResponse.ok) {
                        throw new Error(`Drive API error after token refresh: ${retryResponse.status}`);
                    }
                    
                    const retryData = await retryResponse.json();
                    return retryData.files || [];
                } catch (refreshError) {
                    // Check if refresh token is revoked
                    if (refreshError.message.includes('REVOKED_TOKEN') || refreshError.message.includes('invalid_grant')) {
                        console.error(`  ❌ Token refresh failed - refresh token revoked for ${account.account_email}`);
                        throw new Error(`REVOKED_TOKEN: Account ${account.account_email} needs to re-authenticate. Refresh token has been revoked.`);
                    }
                    console.error(`  ❌ Token refresh failed for ${account.account_email}:`, refreshError.message);
                    throw new Error(`Drive API error: ${response.status} (token refresh failed: ${refreshError.message})`);
                }
            }
            throw new Error(`Drive API error: ${response.status}`);
        }

        const data = await response.json();
        const files = data.files || [];

        console.log(`  ✓ Found ${files.length} Drive files`);

        return files.map(file => ({
            id: file.id,
            name: file.name,
            mimeType: file.mimeType,
            size: file.size || 0,
            modifiedTime: file.modifiedTime,
            owner: file.owners && file.owners.length > 0 ? file.owners[0].displayName || file.owners[0].emailAddress : 'Unknown',
            ownerEmail: file.owners && file.owners.length > 0 ? file.owners[0].emailAddress : '',
            url: file.webViewLink,
            iconLink: file.iconLink
        }));

    } catch (error) {
        console.error('  ❌ Error fetching Drive files:', error.message);
        return [];
    }
}

/**
 * Fetch Drive file contents with automatic token refresh on 401
 * @param {string|Object} accessTokenOrAccount - Google OAuth access token (string) or account object
 * @param {Array} files - Array of file metadata objects
 * @returns {Promise<Array>} - Array of files with content included
 */
async function fetchDriveFileContents(accessTokenOrAccount, files) {
    const isAccountObject = typeof accessTokenOrAccount === 'object' && accessTokenOrAccount !== null;
    let accessToken = isAccountObject ? accessTokenOrAccount.access_token : accessTokenOrAccount;
    let account = isAccountObject ? accessTokenOrAccount : null;
    const filesWithContent = [];

    // Process ALL files found (no artificial limit)
    // Process in batches of 10 to avoid timeouts
    console.log(`  📄 Fetching content for ALL ${files.length} files (processing in batches of 10)...`);

    for (let i = 0; i < files.length; i += 10) {
        const batch = files.slice(i, i + 10);
        console.log(`     Processing batch ${Math.floor(i / 10) + 1}/${Math.ceil(files.length / 10)} (${batch.length} files)...`);

        // Process batch in parallel for speed
        const batchResults = await Promise.allSettled(
            batch.map(async (file) => {
                try {
                    let content = '';

                    // Handle different file types
                    if (file.mimeType === 'application/vnd.google-apps.document') {
                        // Google Doc - export as plain text
                        let response = await fetchWithRetry(
                            `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
                            {
                                headers: { 'Authorization': `Bearer ${accessToken}` }
                            }
                        );
                        
                        // Handle 401 with token refresh
                        if (!response.ok && response.status === 401 && account) {
                            const refreshedAccount = await ensureValidToken(account);
                            accessToken = refreshedAccount.access_token;
                            account = refreshedAccount;
                            response = await fetchWithRetry(
                                `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`,
                                {
                                    headers: { 'Authorization': `Bearer ${accessToken}` }
                                }
                            );
                        }
                        
                        if (response.ok) {
                            content = await response.text();
                        }
                    } else if (file.mimeType === 'application/pdf' || file.mimeType === 'text/plain') {
                        // PDF or text file - get binary content
                        let response = await fetchWithRetry(
                            `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
                            {
                                headers: { 'Authorization': `Bearer ${accessToken}` }
                            }
                        );
                        
                        // Handle 401 with token refresh
                        if (!response.ok && response.status === 401 && account) {
                            const refreshedAccount = await ensureValidToken(account);
                            accessToken = refreshedAccount.access_token;
                            account = refreshedAccount;
                            response = await fetchWithRetry(
                                `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`,
                                {
                                    headers: { 'Authorization': `Bearer ${accessToken}` }
                                }
                            );
                        }
                        
                        if (response.ok) {
                            content = await response.text();
                        }
                    }

                    if (content) {
                        return {
                            ...file,
                            content: content.substring(0, 50000), // Limit to 50k chars per file
                            hasContent: true // Flag to indicate content was successfully fetched
                        };
                    }
                    return {
                        ...file,
                        hasContent: false // Flag to indicate content fetch failed
                    };
                } catch (error) {
                    console.error(`  ⚠️  Error fetching content for ${file.name}:`, error.message);
                    return null;
                }
            })
        );

        // Collect successful results
        batchResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                filesWithContent.push(result.value);
            }
        });
    }

    console.log(`  ✓ Successfully fetched content for ${filesWithContent.length}/${files.length} files`);
    return filesWithContent;
}

/**
 * Fetch user profile information
 * @param {string} accessToken - Google OAuth access token
 * @returns {Promise<Object>} - User profile { email, name, picture }
 */
async function fetchUserProfile(accessToken, retryCount = 0) {
    const maxRetries = 3;
    try {
        if (!accessToken) {
            throw new Error('Access token is missing or undefined');
        }
        
        console.log('Fetching user profile with token (preview):', accessToken.substring(0, 20) + '...');
        
        const response = await fetchWithRetry(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            {
                headers: { 
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (!response.ok) {
            // Add better error details for debugging
            const errorText = await response.text();
            console.error('User info API error details:', {
                status: response.status,
                statusText: response.statusText,
                body: errorText,
                tokenPreview: accessToken ? accessToken.substring(0, 20) + '...' : 'MISSING',
                hasToken: !!accessToken
            });
            throw new Error(`User info API error: ${response.status} - ${errorText || response.statusText}`);
        }

        const data = await response.json();
        return {
            email: data.email,
            name: data.name,
            picture: data.picture,
            verifiedEmail: data.verified_email
        };
    } catch (error) {
        console.error('Error fetching user profile:', error.message);
        throw error;
    }
}

/**
 * Fetch Google Calendar events using Calendar API v3 with automatic token refresh on 401
 * @param {string|Object} accessTokenOrAccount - Google OAuth access token (string) or account object
 * @param {string} timeMin - Start time (ISO string)
 * @param {string} timeMax - End time (ISO string)
 * @param {number} maxResults - Maximum number of events to fetch
 * @returns {Promise<Array>} - Array of calendar events
 */
async function fetchCalendarEvents(accessTokenOrAccount, timeMin, timeMax, maxResults = 100) {
    const isAccountObject = typeof accessTokenOrAccount === 'object' && accessTokenOrAccount !== null;
    let accessToken = isAccountObject ? accessTokenOrAccount.access_token : accessTokenOrAccount;
    let account = isAccountObject ? accessTokenOrAccount : null;
    
    try {
        console.log(`  📅 Calendar query: ${timeMin} to ${timeMax}`);

        const response = await fetchWithRetry(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
            `timeMin=${encodeURIComponent(timeMin)}&` +
            `timeMax=${encodeURIComponent(timeMax)}&` +
            `singleEvents=true&` +
            `orderBy=startTime&` +
            `maxResults=${maxResults}`,
            {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            }
        );

        if (!response.ok) {
            // If 401 and we have account object, try refreshing token once
            if (response.status === 401 && account) {
                console.log(`  🔄 401 error detected, attempting token refresh for ${account.account_email}...`);
                try {
                    const refreshedAccount = await ensureValidToken(account);
                    accessToken = refreshedAccount.access_token;
                    account = refreshedAccount;
                    
                    // Retry the request with refreshed token
                    const retryResponse = await fetchWithRetry(
                        `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
                        `timeMin=${encodeURIComponent(timeMin)}&` +
                        `timeMax=${encodeURIComponent(timeMax)}&` +
                        `singleEvents=true&` +
                        `orderBy=startTime&` +
                        `maxResults=${maxResults}`,
                        {
                            headers: { 'Authorization': `Bearer ${accessToken}` }
                        }
                    );
                    
                    if (!retryResponse.ok) {
                        throw new Error(`Calendar API error after token refresh: ${retryResponse.status}`);
                    }
                    
                    const retryData = await retryResponse.json();
                    const retryEvents = retryData.items || [];
                    console.log(`  ✓ Found ${retryEvents.length} calendar events after token refresh`);
                    return retryEvents.map(event => ({
                        id: event.id,
                        summary: event.summary || 'No title',
                        description: event.description || '',
                        start: event.start?.dateTime || event.start?.date || '',
                        end: event.end?.dateTime || event.end?.date || '',
                        attendees: (event.attendees || []).map(a => ({
                            email: a.email,
                            displayName: a.displayName,
                            responseStatus: a.responseStatus
                        })),
                        location: event.location || '',
                        htmlLink: event.htmlLink,
                        creator: event.creator?.email || '',
                        organizer: event.organizer?.email || ''
                    }));
                } catch (refreshError) {
                    // Check if refresh token is revoked
                    if (refreshError.message.includes('REVOKED_TOKEN') || refreshError.message.includes('invalid_grant')) {
                        console.error(`  ❌ Token refresh failed - refresh token revoked for ${account.account_email}`);
                        throw new Error(`REVOKED_TOKEN: Account ${account.account_email} needs to re-authenticate. Refresh token has been revoked.`);
                    }
                    console.error(`  ❌ Token refresh failed for ${account.account_email}:`, refreshError.message);
                    throw new Error(`Calendar API error: ${response.status} (token refresh failed: ${refreshError.message})`);
                }
            }
            throw new Error(`Calendar API error: ${response.status}`);
        }

        const data = await response.json();
        const events = data.items || [];

        console.log(`  ✓ Found ${events.length} calendar events`);

        return events.map(event => ({
            id: event.id,
            summary: event.summary || 'No title',
            description: event.description || '',
            start: event.start?.dateTime || event.start?.date || '',
            end: event.end?.dateTime || event.end?.date || '',
            attendees: (event.attendees || []).map(a => ({
                email: a.email,
                displayName: a.displayName,
                responseStatus: a.responseStatus
            })),
            location: event.location || '',
            htmlLink: event.htmlLink,
            creator: event.creator?.email || '',
            organizer: event.organizer?.email || ''
        }));

    } catch (error) {
        console.error('  ❌ Error fetching Calendar events:', error.message);
        return [];
    }
}

module.exports = {
    fetchGmailMessages,
    fetchDriveFiles,
    fetchDriveFileContents,
    fetchUserProfile,
    fetchCalendarEvents
};
