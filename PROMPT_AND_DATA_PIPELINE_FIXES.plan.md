# Comprehensive Implementation Plan: GPT Prompts and Data Pipeline Fixes

## Overview
This plan addresses ALL identified issues from the deep analysis across Critical, High, Medium, and Low priorities. Organized by category for systematic implementation.

## CRITICAL PRIORITY FIXES (Data Loss & Filtering Accuracy)

### Fix 1: Remove Hard Email Body Truncation at Fetch Time
**File**: `services/googleApi.js`
**Location**: Line ~170
**Current**: `body: body.substring(0, 15000) // Limit to 15k chars per email`
**Issue**: Truncation happens BEFORE relevance filtering, losing important context
**Fix**: 
- Remove hard truncation at fetch time
- Store full body (or up to 50k chars for very long emails)
- Apply truncation only when needed for GPT calls (with context about truncation)
**Impact**: Preserves full email context for filtering decisions

### Fix 2: Include Email Body in Relevance Filtering
**File**: `routes/meetings.js`
**Location**: Lines 431-460 (email relevance filtering prompt)
**Current**: Only snippet (200 chars) used: `Snippet: ${e.snippet?.substring(0, 200) || ''}`
**Issue**: Critical context lost - filtering decision made without body content
**Fix**:
- Include first 1000-2000 chars of body in filtering prompt
- Format: `Body: ${(e.body || e.snippet || '').substring(0, 2000)}`
- Keep snippet as secondary indicator
**Impact**: Much more accurate relevance filtering

### Fix 3: Reduce Email Filtering Batch Size
**File**: `routes/meetings.js`
**Location**: Line 425 (batch size definition)
**Current**: `batchStart += 50` (50 emails per batch)
**Issue**: Too large - GPT may miss subtle relevance in large batches
**Fix**:
- Change to `batchStart += 25` (25 emails per batch)
- Update batch calculation: `Math.floor(batchStart / 25) + 1}/${Math.ceil(emails.length / 25)}`
**Impact**: Better filtering accuracy, more GPT calls but better results

### Fix 4: Increase Executive Summary Truncation Limits
**File**: `routes/meetings.js`
**Location**: Lines 899-901 (executive summary data preparation)
**Current**: 
```javascript
emailAnalysis: emailAnalysis?.substring(0, 2000) || 'No email context',
documentAnalysis: documentAnalysis?.substring(0, 2000) || 'No document analysis',
relationshipAnalysis: relationshipAnalysis?.substring(0, 2000) || 'No relationship analysis'
```
**Issue**: 2000 chars too low - loses critical context
**Fix**:
- Increase to 4000-5000 chars each
- Or better: Use first 4000 chars + last 1000 chars (beginning + end)
- Add note about truncation in prompt
**Impact**: Preserves critical context in executive summary

### Fix 5: Stricter Email Filtering Fallback
**File**: `routes/meetings.js`
**Location**: Lines 462-469 (parsing fallback)
**Current**: `batchIndices = batchEmails.map((_, i) => batchStart + i);` (includes ALL on failure)
**Issue**: Too permissive - includes irrelevant emails on parse failure
**Fix**:
- Change to: `batchIndices = [];` (include none on failure)
- Log error with batch details
- Add retry logic or manual review flag
**Impact**: Prevents irrelevant emails from polluting analysis

## HIGH PRIORITY FIXES (Filtering & Data Quality)

### Fix 6: Add Date-Based Prioritization to Email Filtering
**File**: `routes/meetings.js`
**Location**: Email relevance filtering prompt (line 431)
**Current**: No date weighting
**Fix**:
- Add date scoring to prompt instructions
- Weight recent emails (last 30 days) higher
- Include date in filtering decision: `Date: ${e.date} (${daysAgo} days ago)`
- Update prompt: "Prioritize emails from last 30 days, but include older emails if highly relevant"
**Impact**: More relevant recent context prioritized

### Fix 7: Add Document Prioritization
**File**: `routes/meetings.js`
**Location**: Document analysis section (line 596)
**Current**: All documents analyzed equally
**Fix**:
- Sort documents by modification date (recent first)
- Prioritize documents shared with more attendees
- Filter out image files, prioritize docs/spreadsheets
- Process in priority order
**Impact**: Focuses analysis on most relevant documents

### Fix 8: Increase Web Search Synthesis Results
**File**: `routes/meetings.js`
**Location**: Line 370 (web search synthesis)
**Current**: `resultsToUse.slice(0, 3)` - only top 3 results
**Fix**:
- Change to `resultsToUse.slice(0, 5)` - top 5 results
- Update prompt to handle 5 results
**Impact**: More comprehensive attendee information

### Fix 9: Add Meeting Context to Web Search Prompt
**File**: `routes/meetings.js`
**Location**: Line 368-372 (web search synthesis prompt)
**Current**: Very brief prompt without meeting context
**Fix**:
- Add meeting title and date context
- Include meeting description if available
- Update prompt: `Extract professional information about ${name} (${attendeeEmail}) for meeting "${meetingTitle}"${meetingDateContext}. Focus on information relevant to this meeting's context. Return JSON array of 3-6 facts (15-80 words each).`
**Impact**: More relevant web search results

### Fix 10: Increase Email Body Truncation in Extraction
**File**: `routes/meetings.js`
**Location**: Line 519 (email context extraction)
**Current**: `Body: ${(e.body || e.snippet || '').substring(0, 3000)}`
**Issue**: 3000 chars may cut off important context
**Fix**:
- Increase to 5000-8000 chars
- Or use first 6000 + last 2000 chars (beginning + end)
**Impact**: Preserves more email context in extraction

## MEDIUM PRIORITY FIXES (Structure & Completeness)

### Fix 11: Add Email Thread Grouping
**File**: `routes/meetings.js`
**Location**: After email fetching, before filtering
**Current**: Individual emails processed separately
**Fix**:
- Group emails by thread (subject + participants)
- Add thread metadata (message count, date range, participants)
- Include thread grouping info in extraction prompt
- Process threads as units where possible
**Impact**: Better understanding of conversation flows

### Fix 12: Add Document Type Awareness
**File**: `routes/meetings.js`
**Location**: Document analysis section (line 611)
**Current**: No document type differentiation
**Fix**:
- Check `file.mimeType` before analysis
- Skip image files (jpg, png, gif)
- Prioritize Google Docs, Sheets, PDFs, Word docs
- Add document type to prompt: `Document type: ${file.mimeType}`
**Impact**: Focuses analysis on text-based documents

### Fix 13: Add Deduplication to Extracted Email Data
**File**: `routes/meetings.js`
**Location**: Lines 536-554 (merging extracted data)
**Current**: No deduplication - may repeat information
**Fix**:
- Add deduplication function before synthesis
- Compare extracted items by similarity (fuzzy match)
- Remove duplicates or merge similar items
- Log deduplication stats
**Impact**: Cleaner, more focused analysis

### Fix 14: Add Token Budget Awareness
**File**: `routes/meetings.js`
**Location**: All GPT prompts
**Current**: No explicit token limits in prompts
**Fix**:
- Calculate approximate token count before GPT calls
- Add token budget warnings to prompts
- Truncate data if approaching limits
- Add instructions: "Stay within token budget - prioritize most important information"
**Impact**: Prevents token limit errors, better prioritization

### Fix 15: Process All Attendees
**File**: `routes/meetings.js`
**Location**: Line 252 (attendee processing limit)
**Current**: `attendees.slice(0, 6)` - only first 6 attendees
**Fix**:
- Remove limit: `attendees.map(...)` instead of `attendees.slice(0, 6).map(...)`
- Add batch processing if >10 attendees
- Log attendee count
**Impact**: Complete attendee analysis

### Fix 16: Add Frontend Error Handling
**File**: `index.html`
**Location**: `renderModernBrief` function (line 3755+)
**Current**: No error handling for malformed data
**Fix**:
- Add try-catch around data access
- Add fallback messages for empty fields
- Validate data structure before rendering
- Show user-friendly error messages
**Impact**: Better UX, prevents crashes

### Fix 17: Add Attendee Count Scoring to Email Filtering
**File**: `routes/meetings.js`
**Location**: Email relevance filtering prompt (line 431)
**Current**: No attendee count consideration
**Fix**:
- Count attendees in email (from + to fields)
- Include attendee count in prompt
- Weight emails with more meeting attendees higher
- Update prompt: "Prioritize emails with multiple meeting attendees"
**Impact**: Better relevance filtering

### Fix 18: Add Person Validation to Web Search
**File**: `routes/meetings.js`
**Location**: Web search filtering (line 354-361)
**Current**: Relaxed filtering may include wrong person
**Fix**:
- Extract person name from search results
- Compare with attendee name (fuzzy match)
- Filter out results where name doesn't match
- Add validation step before synthesis
**Impact**: More accurate attendee information

### Fix 19: Increase Document Content Truncation
**File**: `routes/meetings.js`
**Location**: Line 626 (document analysis)
**Current**: `file.content.substring(0, 20000)` - 20k chars
**Issue**: May miss important sections in large documents
**Fix**:
- Increase to 30000-40000 chars
- Or use first 30k + last 10k chars (beginning + end)
- Add document length info to prompt
**Impact**: More complete document analysis

### Fix 20: Add Prioritization Instructions to Prompts
**File**: `routes/meetings.js`
**Location**: All synthesis prompts
**Current**: No explicit prioritization instructions
**Fix**:
- Add to all prompts: "Prioritize most recent and most relevant information"
- Add: "Order by importance - most critical information first"
- Add: "If data exceeds capacity, prioritize: [specific order]"
**Impact**: Better information hierarchy

### Fix 21: Include Timeline and Recommendations in Summary
**File**: `routes/meetings.js`
**Location**: Executive summary prompt (line 868)
**Current**: No timeline or recommendations in context
**Fix**:
- Add timeline summary to prompt data
- Add recommendations array to prompt data
- Include in synthesis context
**Impact**: More comprehensive executive summary

### Fix 22: Add Attendee keyFacts to Action Items Prompt
**File**: `routes/meetings.js`
**Location**: Action items prompt (line 824)
**Current**: Only attendee names: `brief.attendees.map(a => `${a.name}`).join(', ')`
**Fix**:
- Include keyFacts: `brief.attendees.map(a => `${a.name} (${a.keyFacts?.slice(0, 2).join('; ') || 'no info'})`).join(', ')`
- Or pass full attendee objects
**Impact**: More context-aware action items

### Fix 23: Use Raw Data in Relationship Analysis
**File**: `routes/meetings.js`
**Location**: Relationship analysis prompt (line 708)
**Current**: Uses synthesized `emailAnalysis` and `documentAnalysis`
**Fix**:
- Pass sample raw emails (5-10 most relevant)
- Pass sample raw document content (first 2000 chars of top 3 docs)
- Keep synthesized summaries as secondary context
- Update prompt to use raw data primarily
**Impact**: More specific relationship insights

### Fix 24: Add Deduplication to Document Synthesis
**File**: `routes/meetings.js`
**Location**: Document synthesis prompt (line 651)
**Current**: No deduplication instructions
**Fix**:
- Add deduplication before synthesis
- Add prompt instruction: "Remove duplicate insights across documents"
- Merge similar insights
**Impact**: Cleaner document analysis

### Fix 25: Increase Timeline Limit
**File**: `routes/meetings.js`
**Location**: Line 783 (timeline limit)
**Current**: `timeline.slice(0, 100)` - hard limit of 100 events
**Fix**:
- Increase to 200 events
- Or remove limit and use date-based filtering (last 6 months)
- Add pagination if needed
**Impact**: More complete timeline

### Fix 26: Add Calendar Events to Timeline
**File**: `routes/meetings.js`
**Location**: Timeline building section (line 725)
**Current**: Only emails and documents
**Fix**:
- Add calendar events from `calendarEvents` array
- Format similar to email/document events
- Include event title, date, attendees
**Impact**: More complete interaction history

### Fix 32: Include Emails TO Attendee in Research
**File**: `routes/meetings.js`
**Location**: Attendee email research (line 277)
**Current**: Only emails FROM attendee: `emails.filter(e => e.from?.toLowerCase().includes(attendeeEmail.toLowerCase()))`
**Fix**:
- Also include emails TO attendee: `emails.filter(e => e.from?.toLowerCase().includes(attendeeEmail.toLowerCase()) || e.to?.toLowerCase().includes(attendeeEmail.toLowerCase()))`
- Or fetch both directions separately
- Combine and deduplicate
**Impact**: More complete attendee context

## LOW PRIORITY ENHANCEMENTS (Advanced Features)

### Fix 27: Add Email Attachment Analysis
**File**: `routes/meetings.js`
**Location**: Email context extraction (line 498)
**Current**: No attachment analysis
**Fix**:
- Extract attachment metadata from emails
- Include attachment names/types in extraction prompt
- Add attachment info to extracted data
- Reference attachments in synthesis
**Impact**: More complete email context

### Fix 28: Add Document Collaboration Data
**File**: `services/googleApi.js` or `routes/meetings.js`
**Location**: Document fetching/analysis
**Current**: No collaboration data
**Fix**:
- Fetch document comments if available via Drive API
- Include edit history metadata
- Add collaboration info to document analysis prompt
- Analyze collaboration patterns
**Impact**: Better understanding of document evolution

### Fix 29: Add Calendar Event Content Analysis
**File**: `routes/meetings.js`
**Location**: Calendar event processing (line 180)
**Current**: Only metadata (title, date, attendees)
**Fix**:
- Fetch event description/content if available
- Include in timeline and analysis
- Analyze event descriptions for context
**Impact**: More complete meeting history

### Fix 30: Add Sentiment Analysis to Emails
**File**: `routes/meetings.js`
**Location**: Email context extraction (line 498)
**Current**: No sentiment analysis
**Fix**:
- Add sentiment extraction to email analysis prompt
- Include sentiment in extracted data structure
- Use sentiment in relationship analysis
- Flag tense/conflict indicators
**Impact**: Better relationship dynamics understanding

### Fix 31: Add Interaction Frequency Metrics
**File**: `routes/meetings.js`
**Location**: Relationship analysis (line 708)
**Current**: No frequency metrics
**Fix**:
- Calculate email frequency between attendees
- Calculate document collaboration frequency
- Include frequency metrics in relationship analysis prompt
- Use frequency to weight relationship strength
**Impact**: More quantitative relationship insights

## Implementation Order

### Phase 1: Critical Data Loss Fixes (Immediate)
1. Fix 1: Remove hard email truncation
2. Fix 2: Include body in filtering
3. Fix 3: Reduce batch size
4. Fix 4: Increase summary truncation
5. Fix 5: Stricter fallback

### Phase 2: High Priority Filtering (Week 1)
6. Fix 6: Date prioritization
7. Fix 7: Document prioritization
8. Fix 8: More web results
9. Fix 9: Web search context
10. Fix 10: More email body in extraction

### Phase 3: Medium Priority Structure (Week 2)
11-26: All medium priority fixes

### Phase 4: Low Priority Enhancements (Week 3+)
27-31: Advanced features

## Testing Strategy

For each fix:
1. Test with real meeting data
2. Compare before/after outputs
3. Verify no regressions
4. Check token usage
5. Validate field population
6. Test edge cases (empty data, malformed data, large datasets)

## Success Metrics

- Email relevance filtering accuracy: Target 80%+ relevant emails included
- Document analysis completeness: Target 90%+ key insights captured
- Executive summary quality: Target 95%+ user satisfaction
- Token usage: Stay within GPT-4o limits
- Processing time: < 2 minutes for typical meeting
- Field population: 100% of fields populated with valid data

