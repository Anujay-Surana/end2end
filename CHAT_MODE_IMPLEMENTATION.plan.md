# Chat Mode UI Implementation Plan

## Overview
Add a "Chat Mode" button that switches to a completely different UI allowing users to:
1. Select a date (day/month/year)
2. Choose "Day Prep" - runs meeting prep on all meetings for that day (5-7 minute voice brief)
3. Choose "Meeting Prep" - select a meeting from that day and start voice prep (2-minute brief)

## Voice Infrastructure Upgrade: OpenAI Realtime API (o1-realtime)

### Current Architecture (TO BE REPLACED)
- **STT**: Deepgram Nova-2
- **TTS**: OpenAI TTS-1
- **LLM**: GPT-4o
- **Latency**: ~1.5-2s for full response

### New Architecture: OpenAI Realtime API
- **Model**: o1-realtime with streaming
- **Latency**: ~320ms target (super fast)
- **Quality**: ChatGPT voice mode quality (super effective)
- **Features**:
  - Native voice-to-voice (no separate STT/TTS)
  - Streaming responses
  - Built-in interruption handling
  - Natural conversation flow
- **Endpoint**: `wss://api.openai.com/v1/realtime`
- **Cost**: 2-10x more expensive than current setup, but worth it for quality/speed

### Implementation Requirements
- Replace Deepgram STT + OpenAI TTS with Realtime API
- Update WebSocket handling for Realtime API protocol
- Implement streaming audio handling
- Update interruption/resumption logic for Realtime API
- Test latency and quality improvements

## Day Prep Structure

### Shadow Persona
- Calm, confident, senior Chief of Staff tone
- No chatter, no enthusiasm padding, no emojis, no corporate buzzwords
- Every sentence must add value
- Target: 5-7 minutes (~750-1000 words)
- Natural spoken tone (no bullets, no headings)

### Structure
1. **Orientation (30-45 seconds)**
   - Name the day
   - Overall "theme" or shape of the day
   - Preview type of meetings ahead

2. **Morning Block (60-90 sec)**
   - Key meetings
   - What matters most
   - Decisions required
   - People dynamics
   - Risks + opportunities

3. **Midday Block (60-90 sec)**
   - High-signal prep
   - Open loops that affect meetings
   - Strategic framing

4. **Afternoon/Evening Block (60-90 sec)**
   - External calls, partner discussions
   - Mental posture
   - Energy/flow considerations

5. **Day's Win Condition (45 sec)**
   - What "success" looks like for the day
   - Tie to weekly + long-term goals

6. **Optional Questions**
   - Only if directly relevant
   - ONE question at a time
   - No open-ended fluff

### Interruption Rules
- Stop immediately when user interrupts
- Answer question directly (<20 seconds)
- Use stored context, embeddings, or web search
- Never say: "Let me pause", "As I was saying", "Do you want me to resume?", etc.
- Resume from exact sentence left off
- No repetition, no restarting, no meta-explanations

## Implementation Tasks

### Phase 1: UI Structure
1. **Add Chat Mode Toggle**
   - Add "Chat Mode" button in main UI header
   - Toggle between calendar view and chat mode view
   - Store mode state in JavaScript

2. **Create Chat Mode UI Container**
   - New container div that replaces calendar view when active
   - Minimalist, card-based design
   - Date picker component (day/month/year selector)
   - Visual calendar picker or input fields
   - Default to today's date

3. **Add Action Buttons**
   - "Day Prep" button (primary, large card)
   - "Meeting Prep" button (secondary, large card)
   - Clear visual hierarchy

### Phase 2: Backend Endpoints

1. **Create Day Prep Endpoint**
   - `POST /api/day-prep`
   - Accepts: `{ date: "YYYY-MM-DD", userId: "..." }`
   - Fetches all meetings for that day from Google Calendar (all accounts)
   - Runs `/api/prep-meeting` on each meeting **IN PARALLEL**
   - Synthesizes all briefs into day prep format using Shadow persona prompt
   - Returns: `{ date, meetings: [...], dayPrep: {...} }`

2. **Create Meetings for Day Endpoint**
   - `GET /api/meetings-for-day?date=YYYY-MM-DD`
   - Returns list of meetings for that day
   - Includes: meeting ID, title, time, attendees count
   - Used by frontend to show meeting selection modal

3. **Voice Prep Integration**
   - Existing `voice_prep_start` WebSocket message works
   - Needs meeting brief passed to it
   - Will upgrade to Realtime API later

### Phase 3: Frontend Implementation

1. **Day Prep Flow**
   - User selects date → clicks "Day Prep"
   - Show loading state with progress
   - Call `/api/day-prep`
   - Display day prep results
   - Show all meetings with their prep status
   - Start voice prep with day prep content

2. **Meeting Prep Flow**
   - User selects date → clicks "Meeting Prep"
   - Fetch meetings for that day (`/api/meetings-for-day`)
   - Display meeting selection **MODAL** (card-based, minimalist)
   - Meeting cards show: time, title, attendees count
   - User selects meeting
   - Fetch meeting brief (`/api/prep-meeting`)
   - Initialize voice prep WebSocket connection
   - Start voice prep mode (reuse existing voice prep UI/modal)

3. **Date Selection Logic**
   - Validate date selection
   - Handle timezone properly
   - Show "No meetings" state if empty

### Phase 4: Day Prep Synthesis Service

1. **Create Day Prep Synthesizer**
   - `services/dayPrepSynthesizer.js`
   - Takes array of meeting briefs
   - Uses Shadow persona prompt
   - Structures output per specification:
     - Orientation
     - Morning Block
     - Midday Block
     - Afternoon/Evening Block
     - Day's Win Condition
   - Handles interruption/resumption logic
   - Returns structured day prep narrative

2. **Integration with Voice Prep**
   - Day prep output feeds into voice prep system
   - Supports interruptions and resumption
   - Uses same voice infrastructure (upgraded to Realtime API)

### Phase 5: Voice Infrastructure Upgrade (Realtime API)

1. **Research Realtime API**
   - Review OpenAI Realtime API documentation
   - Understand WebSocket protocol
   - Understand streaming audio format
   - Understand interruption handling

2. **Create Realtime API Service**
   - `services/openaiRealtime.js`
   - Handle WebSocket connection to `wss://api.openai.com/v1/realtime`
   - Implement audio streaming
   - Handle interruptions
   - Support resumption

3. **Update Voice Prep Services**
   - Replace Deepgram STT in `voicePrepBriefing.js`
   - Replace OpenAI TTS in `voicePrepBriefing.js`
   - Update `voiceConversation.js` for Realtime API
   - Test latency improvements

4. **Update WebSocket Handler**
   - Modify `server.js` WebSocket handler
   - Support Realtime API protocol
   - Handle streaming audio chunks
   - Maintain backward compatibility during transition

## File Changes

### New Files
- `routes/dayPrep.js` - Day Prep endpoint
- `services/dayPrepSynthesizer.js` - Synthesizes multiple meeting briefs into day prep
- `services/openaiRealtime.js` - OpenAI Realtime API integration

### Modified Files
- `index.html` - Add chat mode UI, toggle button, date picker, meeting selection modal
- `server.js` - Add `/api/day-prep` and `/api/meetings-for-day` routes, update WebSocket for Realtime API
- `services/voicePrepBriefing.js` - Upgrade to Realtime API
- `services/voiceConversation.js` - Upgrade to Realtime API

## Implementation Order

1. **Phase 1**: UI Structure (Chat Mode toggle, date picker, buttons)
2. **Phase 2**: Backend endpoints (day-prep, meetings-for-day)
3. **Phase 3**: Frontend flows (Day Prep, Meeting Prep modal)
4. **Phase 4**: Day Prep synthesis (Shadow persona, structure)
5. **Phase 5**: Voice infrastructure upgrade (Realtime API)

## Notes

- Day Prep runs meeting prep in parallel for speed
- Meeting selection uses modal for better UX
- Voice infrastructure upgrade is significant but necessary for quality
- Shadow persona is critical - must sound like senior Chief of Staff
- Interruption handling must be seamless (no meta-phrases)

