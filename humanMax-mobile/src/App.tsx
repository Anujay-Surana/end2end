import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { SplashScreen } from '@capacitor/splash-screen';
import { App as CapacitorApp } from '@capacitor/app';
import { authService } from './services/authService';
import { notificationService } from './services/notificationService';
import { backgroundSyncService } from './services/backgroundSync';
import { AuthView } from './components/AuthView';
import { HomeView } from './components/HomeView';
import { ChatView } from './components/ChatView';
import { NotesView } from './components/NotesView';
import { Settings } from './components/Settings';
import { MeetingDetailModal } from './components/MeetingDetailModal';
import { PrepChatView } from './components/PrepChatView';
import { ListeningView } from './components/ListeningView';
import { MeetingPrep } from './components/MeetingPrep';
import { MeetingModal } from './components/MeetingModal';
import type { User, Meeting } from './types';
import './App.css';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [notificationMeeting, setNotificationMeeting] = useState<Meeting | null>(null);

  useEffect(() => {
    initializeApp();
    
    // Initialize notifications and background sync (non-blocking)
    if (Capacitor.isNativePlatform()) {
      // Don't await - let these initialize in background
      notificationService.initialize().catch(() => {});
      backgroundSyncService.initialize().catch(() => {});
      
      // Set up notification tap handler
      const unsubscribe = notificationService.onNotificationTap((data) => {
        if (data.type === 'meeting_reminder' && data.meeting_id) {
          // Fetch meeting details and show modal
          // TODO: Fetch meeting from API or use cached meetings
          setNotificationMeeting({
            id: data.meeting_id,
            summary: data.meeting_title || 'Meeting',
            start: { dateTime: data.start_time },
          } as Meeting);
        } else if (data.type === 'daily_summary') {
          // Could show chat view or navigate to main screen
          // For now, just log
          console.log('Daily summary notification tapped');
        }
      });
      
      // Store unsubscribe for cleanup
      return () => {
        unsubscribe();
      };
    }

    // Listen for sign-in events from OAuth callback
    const handleUserSignedIn = (event: CustomEvent) => {
      console.log('User signed in event received:', event.detail);
      setUser(event.detail);
    };
    window.addEventListener('userSignedIn', handleUserSignedIn as EventListener);

    // Handle app state changes
    if (Capacitor.isNativePlatform()) {
      CapacitorApp.addListener('appStateChange', async ({ isActive }) => {
        if (isActive && user) {
          // App came to foreground - refresh data and sync
          handleSignIn();
          if (await backgroundSyncService.shouldSync()) {
            await backgroundSyncService.syncCalendarData();
          }
        }
      });
    }
    
    return () => {
      window.removeEventListener('userSignedIn', handleUserSignedIn as EventListener);
      if (Capacitor.isNativePlatform()) {
        CapacitorApp.removeAllListeners();
      }
    };

    return () => {
      if (Capacitor.isNativePlatform()) {
        CapacitorApp.removeAllListeners();
      }
    };
  }, []);

  const initializeApp = () => {
    // Hide splash screen FIRST - show UI immediately (don't await anything)
    setLoading(false);
    if (Capacitor.isNativePlatform()) {
      SplashScreen.hide().catch(() => {});
    }

    // Configure status bar for iOS (non-blocking, fire-and-forget)
    if (Capacitor.isNativePlatform()) {
      StatusBar.setStyle({ style: Style.Light }).catch(() => {});
      StatusBar.setBackgroundColor({ color: '#ffffff' }).catch(() => {});
      StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {}); // Full screen
    }

    // Load cached user and verify session in background (completely non-blocking)
    // Use setTimeout to ensure this doesn't block rendering
    setTimeout(() => {
      authService.loadStoredUser()
        .then((storedUser) => {
          if (storedUser) {
            setUser(storedUser); // Show UI immediately with cached user
          }
          
          // Verify session in background (non-blocking)
          authService.checkSession()
            .then((currentUser) => {
              if (currentUser) {
                setUser(currentUser);
              } else if (storedUser) {
                // Session expired, clear cached user
                setUser(null);
              }
            })
            .catch(() => {
              // Network error - keep cached user if available
              if (!storedUser) {
                setUser(null);
              }
            });
        })
        .catch(() => {
          // No cached user - try to check session
          authService.checkSession()
            .then((currentUser) => {
              if (currentUser) {
                setUser(currentUser);
              } else {
                setUser(null);
              }
            })
            .catch(() => {
              setUser(null);
            });
        });
    }, 0); // Execute after current call stack, doesn't block rendering
  };

  const handleSignIn = async () => {
    // Check if user was set by auth service (from OAuth callback)
    const currentUser = authService.getCurrentUser();
    if (currentUser) {
      setUser(currentUser);
    } else {
      // Fallback: check session
      const sessionUser = await authService.checkSession();
      setUser(sessionUser);
    }
  };

  const handleSignOut = () => {
    setUser(null);
    setSelectedMeeting(null);
  };

  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <AuthView onSignIn={handleSignIn} />;
  }

  return (
    <Router>
      <AppContent 
        selectedMeeting={selectedMeeting}
        setSelectedMeeting={setSelectedMeeting}
        handleSignOut={handleSignOut}
        notificationMeeting={notificationMeeting}
        setNotificationMeeting={setNotificationMeeting}
      />
    </Router>
  );
}

interface AppContentProps {
  selectedMeeting: Meeting | null;
  setSelectedMeeting: (meeting: Meeting | null) => void;
  handleSignOut: () => void;
  notificationMeeting: Meeting | null;
  setNotificationMeeting: (meeting: Meeting | null) => void;
}

function AppContent({ 
  selectedMeeting, 
  setSelectedMeeting, 
  handleSignOut, 
  notificationMeeting, 
  setNotificationMeeting 
}: AppContentProps) {
  const navigate = useNavigate();
  const location = useLocation();
  
  // State for meeting flow: Home -> MeetingDetail -> PrepChat -> Listening
  const [detailMeeting, setDetailMeeting] = useState<Meeting | null>(null);
  const [prepMeeting, setPrepMeeting] = useState<Meeting | null>(null);
  const [listeningMeeting, setListeningMeeting] = useState<Meeting | null>(null);
  
  // Handle meeting click from HomeView
  const handleMeetingClick = (meeting: Meeting) => {
    setDetailMeeting(meeting);
  };
  
  // Handle Prep button from MeetingDetailModal
  const handlePrep = (meeting: Meeting) => {
    setDetailMeeting(null);
    setPrepMeeting(meeting);
  };
  
  // Handle Listen In from PrepChatView
  const handleListenIn = () => {
    if (prepMeeting) {
      setListeningMeeting(prepMeeting);
    }
  };
  
  // Close handlers
  const closeDetailModal = () => setDetailMeeting(null);
  const closePrepChat = () => setPrepMeeting(null);
  const closeListening = () => setListeningMeeting(null);
  
  return (
    <div className="app">
      <nav className="app-nav">
        <div className="nav-content">
          <h1 className="app-title">Shadow</h1>
          <div className="nav-actions">
            <button
              className={`nav-button ${location.pathname === '/home' ? 'active' : ''}`}
              onClick={() => navigate('/home')}
            >
              🏠 Home
            </button>
            <button
              className={`nav-button ${location.pathname === '/chat' ? 'active' : ''}`}
              onClick={() => navigate('/chat')}
            >
              💬 Chat
            </button>
            <button
              className={`nav-button ${location.pathname === '/notes' ? 'active' : ''}`}
              onClick={() => navigate('/notes')}
            >
              📝 Notes
            </button>
            <button
              className={`nav-button ${location.pathname === '/settings' ? 'active' : ''}`}
              onClick={() => navigate('/settings')}
            >
              ⚙️
            </button>
          </div>
        </div>
      </nav>

      <main className="app-main">
        <Routes>
          <Route
            path="/"
            element={<Navigate to="/home" replace />}
          />
          <Route
            path="/home"
            element={<HomeView onMeetingClick={handleMeetingClick} />}
          />
          <Route
            path="/chat"
            element={<ChatView />}
          />
          <Route
            path="/notes"
            element={<NotesView />}
          />
          <Route
            path="/settings"
            element={<Settings onSignOut={handleSignOut} />}
          />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </main>

      {/* Meeting Detail Modal */}
      {detailMeeting && (
        <MeetingDetailModal
          meeting={detailMeeting}
          onClose={closeDetailModal}
          onPrep={handlePrep}
        />
      )}

      {/* Prep Chat View */}
      {prepMeeting && (
        <PrepChatView
          meeting={prepMeeting}
          onClose={closePrepChat}
          onListenIn={handleListenIn}
        />
      )}

      {/* Listening View */}
      {listeningMeeting && (
        <ListeningView
          meeting={listeningMeeting}
          onClose={closeListening}
        />
      )}

      {/* Legacy modals for backward compatibility */}
      {selectedMeeting && (
        <MeetingPrep
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
        />
      )}

      {notificationMeeting && (
        <MeetingModal
          meeting={notificationMeeting}
          onClose={() => setNotificationMeeting(null)}
        />
      )}
    </div>
  );
}

export default App;
