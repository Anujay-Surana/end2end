# Fix Chat Tangents & Auto-Detect Timezone from Calendar

## Problem Analysis

### Issue 1: Chat Going on Tangents
When users ask to prep for meetings, the AI assistant sometimes goes off on tangents instead of staying focused on the meeting prep request. The current system prompt says "Keep responses under 100 words" but this isn't strict enough, especially for meeting prep scenarios.

### Issue 2: Timezone Not Extracted from Calendar
Currently, user timezone defaults to 'UTC' and isn't automatically detected from their Google Calendar events. Google Calendar API provides timezone information in calendar events (`start.timeZone` and `end.timeZone`), but we're not extracting or using this information.

## Solution

### 1. Strengthen Chat System Prompt
Update the system prompt in `chat_panel_service.py` to be more explicit about:
- Staying focused on the user's specific request
- Avoiding tangents and unnecessary elaboration
- For meeting prep requests, directly calling the tool without extra commentary

### 2. Extract Timezone from Calendar Events
- Update `_format_calendar_event` to preserve timezone information from Google Calendar API
- Extract the most common timezone from user's calendar events
- Update user's timezone in database when detected

### 3. Auto-Update User Timezone
- Add timezone extraction logic when fetching calendar events
- Update user's timezone field in database automatically
- Only update if timezone is different from current value

## Implementation Plan

### Step 1: Fix Chat Prompt (chat_panel_service.py)
- Add explicit instructions to stay focused
- Emphasize direct tool usage for meeting prep
- Add instruction to avoid tangents

### Step 2: Update Calendar Event Formatting (google_api.py)
- Modify `_format_calendar_event` to preserve `timeZone` from `start` and `end` objects
- Return timezone information in formatted events

### Step 3: Add Timezone Update Function (users.py)
- Update `update_user` to support timezone field
- Create helper function to extract most common timezone from calendar events

### Step 4: Auto-Detect Timezone (meetings.py / function_executor.py)
- Add timezone extraction when fetching calendar events
- Update user timezone if detected and different from current value

## Files to Modify

1. `shadow-python/app/services/chat_panel_service.py` - Strengthen system prompt
2. `shadow-python/app/services/google_api.py` - Preserve timezone in calendar events
3. `shadow-python/app/db/queries/users.py` - Add timezone update support
4. `shadow-python/app/services/function_executor.py` - Extract and update timezone from calendar
5. `shadow-python/app/routes/meetings.py` - Extract timezone when fetching meetings

