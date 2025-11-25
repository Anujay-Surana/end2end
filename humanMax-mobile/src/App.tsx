import { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
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
    
    // Initialize notifications and background sync
    if (Capacitor.isNativePlatform()) {
      notificationService.initialize();
      backgroundSyncService.initialize();
    }

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
      if (Capacitor.isNativePlatform()) {
        CapacitorApp.removeAllListeners();
      }
    };
  }, []);

  const initializeApp = async () => {
    try {
      // Configure status bar for iOS
      if (Capacitor.isNativePlatform()) {
        await StatusBar.setStyle({ style: Style.Light });
        await StatusBar.setBackgroundColor({ color: '#ffffff' });
      }

      // Check for existing session
      const storedUser = await authService.loadStoredUser();
      if (storedUser) {
        setUser(storedUser);
        // Verify session is still valid
        const currentUser = await authService.checkSession();
        if (currentUser) {
          setUser(currentUser);
        } else {
          setUser(null);
        }
      } else {
        // Try to check session from server
        const currentUser = await authService.checkSession();
        if (currentUser) {
          setUser(currentUser);
        }
      }
    } catch (error) {
      console.error('Error initializing app:', error);
    } finally {
      setLoading(false);
      // Hide splash screen
      if (Capacitor.isNativePlatform()) {
        await SplashScreen.hide();
      }
    }
  };

  const handleSignIn = async () => {
    const currentUser = await authService.checkSession();
    setUser(currentUser);
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
      <div className="app">
        <nav className="app-nav">
          <div className="nav-content">
            <h1 className="app-title">HumanMax</h1>
            <div className="nav-actions">
              <button
                className="nav-button"
                onClick={() => setShowDayPrep(true)}
              >
                Day Prep
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
    </Router>
  );
}

export default App;
