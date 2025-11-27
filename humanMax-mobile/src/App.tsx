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
import { CalendarView } from './components/CalendarView';
import { Settings } from './components/Settings';
import { MeetingPrep } from './components/MeetingPrep';
import { DayPrep } from './components/DayPrep';
import type { User, Meeting } from './types';
import './App.css';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [showDayPrep, setShowDayPrep] = useState(false);
  const [currentDate] = useState(new Date());

  useEffect(() => {
    initializeApp();
    
    // Initialize notifications and background sync (non-blocking)
    if (Capacitor.isNativePlatform()) {
      // Don't await - let these initialize in background
      notificationService.initialize().catch(() => {});
      backgroundSyncService.initialize().catch(() => {});
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
    setShowDayPrep(false);
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
        showDayPrep={showDayPrep}
        setShowDayPrep={setShowDayPrep}
        currentDate={currentDate}
        handleSignOut={handleSignOut}
      />
    </Router>
  );
}

function AppContent({ selectedMeeting, setSelectedMeeting, showDayPrep, setShowDayPrep, currentDate, handleSignOut }: any) {
  const navigate = useNavigate();
  const location = useLocation();
  
  return (
    <div className="app">
      <nav className="app-nav">
        <div className="nav-content">
          <h1 className="app-title">Shadow</h1>
          <div className="nav-actions">
            <button
              className="nav-button"
              onClick={() => setShowDayPrep(true)}
            >
              Day Prep
            </button>
            <button
              className={`nav-button ${location.pathname === '/settings' ? 'active' : ''}`}
              onClick={() => navigate('/settings')}
            >
              ⚙️ Settings
            </button>
          </div>
        </div>
      </nav>

        <main className="app-main">
          <Routes>
            <Route
              path="/"
              element={
                <CalendarView />
              }
            />
            <Route
              path="/settings"
              element={<Settings onSignOut={handleSignOut} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        {selectedMeeting && (
          <MeetingPrep
            meeting={selectedMeeting}
            onClose={() => setSelectedMeeting(null)}
          />
        )}

        {showDayPrep && (
          <DayPrep
            date={currentDate}
            onClose={() => setShowDayPrep(false)}
          />
        )}
      </div>
  );
}

export default App;
