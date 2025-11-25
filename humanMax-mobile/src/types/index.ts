// User types
export interface User {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export interface Session {
  expires_at: string;
}

export interface AuthResponse {
  success: boolean;
  user: User;
  session: Session;
  access_token?: string;
  token_expires_at?: string;
}

// Account types
export interface Account {
  id: string;
  email: string;
  name: string;
  provider: string;
  is_primary: boolean;
  scopes: string[];
  token_expires_at: string;
  created_at: string;
}

export interface AccountsResponse {
  success: boolean;
  accounts: Account[];
}

// Meeting types
export interface MeetingAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
}

export interface MeetingDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface Meeting {
  id: string;
  summary: string;
  title?: string;
  description?: string;
  start: MeetingDateTime;
  end: MeetingDateTime;
  attendees?: MeetingAttendee[];
  location?: string;
  htmlLink?: string;
  accountEmail?: string;
}

export interface MeetingsResponse {
  meetings: Meeting[];
}

// Meeting Prep types
export interface MeetingPrepSection {
  title: string;
  content: string;
}

export interface MeetingPrep {
  meetingTitle: string;
  meetingDate: string;
  sections: MeetingPrepSection[];
  summary?: string;
}

export interface MeetingPrepResponse {
  success: boolean;
  prep: MeetingPrep;
}

// Day Prep types
export interface DayPrep {
  date: string;
  summary: string;
  meetings: Meeting[];
  prep?: MeetingPrep[];
}

export interface DayPrepResponse {
  success: boolean;
  dayPrep: DayPrep;
}

// API Error types
export interface ApiError {
  error: string;
  message: string;
  field?: string;
  requestId?: string;
}

