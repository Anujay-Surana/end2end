# HumanMax Calendar - AI-Powered Meeting Preparation

An intelligent calendar application that uses Google OAuth to access your calendar, emails, and drive files, then leverages AI to prepare comprehensive meeting briefs.

## Features

- Google Calendar integration with event navigation
- Real-time countdown to meetings
- Past emails and events from attendees
- Relevant attachments and Drive files
- AI-powered meeting preparation with:
  - Web research on attendees and companies (Parallel AI)
  - Deep analysis of emails, documents, and context (OpenAI GPT-4o)
  - Strategic recommendations
  - Tabbed interface for organized information

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

The `.env` file should already be present with:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `OPENAI_API_KEY`
- `PARALLEL_API_KEY`

### 3. Start the Proxy Server

The proxy server is required to handle Parallel AI API calls (to bypass CORS restrictions):

```bash
npm start
```

This will start the proxy server on `http://localhost:3000`

### 4. Start the Frontend Server

In a separate terminal, start a simple HTTP server for the frontend:

```bash
# Using Python 3
python3 -m http.server 8000

# OR using Python 2
python -m SimpleHTTPServer 8000

# OR using Node.js http-server (install with: npm install -g http-server)
http-server -p 8000
```

### 5. Access the Application

Open your browser and navigate to:
```
http://localhost:8000
```

## Usage

1. **Sign in with Google** - Click the sign-in button and authorize access to Calendar, Gmail, and Drive
2. **Navigate Calendar** - Use arrow buttons to view different days
3. **View Meeting Details** - Click on any meeting to see detailed information including:
   - Attendee information
   - Past emails from attendees
   - Past events with same attendees
   - Relevant attachments
   - Related Drive files
4. **Prepare for Meeting** - Click the "Prep Me" button to generate an AI-powered brief that includes:
   - Meeting overview and context
   - Attendee profiles with web research
   - Email thread analysis
   - Document summaries
   - Web intelligence on companies and topics
   - Strategic recommendations

## Architecture

- **Frontend**: Single-page application (`index.html`) with vanilla JavaScript
- **Proxy Server**: Node.js/Express server (`server.js`) that handles Parallel AI API calls
- **APIs Used**:
  - Google Calendar API v3
  - Gmail API v1
  - Google Drive API v3
  - OpenAI GPT-4o
  - Parallel AI Web Search

## Development

To run in development mode with auto-restart:

```bash
npm run dev
```

This uses nodemon to automatically restart the server when files change.

## Note

Make sure both servers are running:
- Proxy server on port 3000 (handles API calls)
- Frontend server on port 8000 (serves the HTML/JS)
