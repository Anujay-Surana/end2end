# Railway Integration & Minimalist UI Redesign Plan

## Overview
Integrate Railway backend URL and completely redesign iOS app UI with minimalist black/white theme, ensuring iOS responsiveness and production-ready polish.

## Phase 1: Railway Backend Integration (30 min)

### 1.1 Update API Client
**File**: `src/services/apiClient.ts`
- Change API base URL to: `http://end2end-production.up.railway.app`
- Use environment variable: `VITE_API_URL`
- Keep localhost fallback for development
- Handle HTTPS/HTTP properly

### 1.2 Update Environment
**File**: `.env`
- Add: `VITE_API_URL=http://end2end-production.up.railway.app`

### 1.3 Verify Backend CORS
**File**: `server.js` in main project
- Ensure Railway domain (`end2end-production.up.railway.app`) is in allowed origins
- Verify session cookies work with Railway domain

## Phase 2: Minimalist Black/White UI Redesign (4-5 hours)

### 2.1 Design System Foundation
**File**: `src/styles/design-system.css` (new)
- **Colors:**
  - Pure Black: `#000000` (primary background)
  - Pure White: `#FFFFFF` (primary text, cards)
  - Gray Scale: `#1a1a1a`, `#2d2d2d`, `#6b7280`, `#9ca3af`, `#e5e7eb`, `#f9fafb`
- **Typography:**
  - System fonts: `-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif`
  - Hierarchy: 32px/24px/18px/16px/14px
  - Weights: 400 (regular), 500 (medium), 600 (semibold)
- **Spacing:** 4px grid (4, 8, 12, 16, 24, 32, 48px)
- **Borders:** 1px solid, minimal use
- **Shadows:** None or very subtle

### 2.2 iOS-Specific Responsive Design
- Safe area handling (notch, home indicator) - use `env(safe-area-inset-*)`
- Touch targets: minimum 44x44px for all interactive elements
- Proper viewport meta tags in `index.html`
- iOS-specific font rendering optimizations
- Handle different screen sizes (iPhone SE to Pro Max)
- Support both portrait and landscape orientations
- Proper keyboard handling and avoidance
- Pull-to-refresh styling (iOS native feel)
- Native iOS scrolling behavior
- Haptic feedback considerations

### 2.3 Component Redesigns

**AuthView** (`src/components/AuthView.tsx` + CSS)
- Black background (#000000)
- White text
- Minimalist sign-in button (white text on black, or black on white)
- Remove gradients, use solid colors
- Clean, centered layout
- Large, readable typography
- Safe area padding

**CalendarView** (`src/components/CalendarView.tsx` + CSS)
- Clean day navigation (minimal arrows, clear date display)
- White cards on black background (or vice versa)
- Better spacing between meetings
- Remove unnecessary borders/decorations
- Clean typography hierarchy
- Responsive to screen width
- Touch-friendly navigation buttons

**MeetingList** (`src/components/MeetingList.tsx` + CSS)
- Minimalist meeting cards
- Clean time badges
- Better content hierarchy
- Remove shadows, use borders sparingly
- Improved spacing and readability
- Minimum 44px touch targets
- Proper card spacing for scrolling

**MeetingDetail** (`src/components/MeetingDetail.tsx` + CSS)
- Clean modal/overlay design
- Better content organization
- Minimalist close buttons
- Safe area handling for modals
- Scrollable content area
- Proper spacing

**MeetingPrep** (`src/components/MeetingPrep.tsx` + CSS)
- Clean modal design
- Better content organization
- Improved typography for prep content
- Clean section dividers
- Scrollable with proper padding
- Loading states

**DayPrep** (`src/components/DayPrep.tsx` + CSS)
- Clean modal design
- Better list layout
- Improved readability
- Proper spacing

**Settings** (`src/components/Settings.tsx` + CSS)
- Clean list design
- Minimalist account cards
- Better spacing
- Clean action buttons
- iOS-style sections
- Proper touch targets

### 2.4 App-wide Styles
**File**: `src/App.css`
- Global reset with minimalist approach
- Consistent spacing system
- Clean navigation bar (black/white)
- Better safe area handling for iOS
- Remove all unnecessary styling
- Proper body/html setup
- iOS-specific optimizations

### 2.5 Production-Ready Polish
- Consistent spacing system throughout
- Proper loading states (skeleton loaders)
- Error states with clear messaging
- Empty states (no meetings, no accounts, etc.)
- Smooth transitions and animations
- Proper focus states for accessibility
- Optimized for performance
- Proper image handling
- Clean button styles
- Consistent form inputs

## Implementation Order
1. Update API to Railway URL
2. Create design system CSS
3. Update App.css with global styles
4. Redesign AuthView
5. Redesign CalendarView
6. Redesign MeetingList
7. Redesign MeetingDetail & MeetingPrep
8. Redesign DayPrep
9. Redesign Settings
10. Test on device
11. Polish and refine

## Key Principles
- **Minimalism:** Remove all unnecessary elements
- **Black/White:** Pure color scheme, no gradients
- **iOS Native:** Feel like a native iOS app
- **Responsive:** Work on all iPhone sizes
- **Production Ready:** Polished, professional, ready to ship

