import { apiClient } from './apiClient';
import { Preferences } from '@capacitor/preferences';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import type { User } from '../types';

// Google OAuth configuration
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
// Include userinfo scopes to fetch user profile (email, name, picture)
const SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly';
// Use HTTPS for Railway (Railway uses HTTPS by default)
const API_URL = import.meta.env.VITE_API_URL || 'https://end2end-production.up.railway.app';

// Validate CLIENT_ID is configured
if (!CLIENT_ID || CLIENT_ID.trim() === '') {
  console.error('❌ VITE_GOOGLE_CLIENT_ID is not configured!');
  console.error('Please set VITE_GOOGLE_CLIENT_ID in your environment variables or .env file');
  console.error('Example: VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com');
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initCodeClient: (config: {
            client_id: string;
            scope: string;
            ux_mode: 'popup' | 'redirect';
            callback: (response: { code?: string; error?: string; error_description?: string }) => void;
          }) => {
            requestCode: () => void;
            callback: (response: { code?: string; error?: string; error_description?: string }) => void;
          };
        };
      };
    };
  }
}

class AuthService {
  private currentUser: User | null = null;
  private accessToken: string | null = null;
  private tokenClient: any = null;
  private processingCallback = false; // Prevent duplicate processing

  constructor() {
    // Only initialize Google Identity Services for web platform
    // Native platforms use Browser plugin instead
    if (!Capacitor.isNativePlatform()) {
      this.initializeWebGoogleSignIn();
    }
    
    // Setup app URL listener for Browser plugin OAuth callbacks
    if (Capacitor.isNativePlatform()) {
      console.log('📱 Native platform detected, setting up app URL listener...');
      this.setupAppUrlListener();
      console.log('✅ App URL listener setup complete');
    } else {
      console.log('🌐 Web platform detected, skipping app URL listener');
    }
  }

  private async initializeWebGoogleSignIn(): Promise<void> {
    // For web and Capacitor WebView, use Google Identity Services
    return new Promise((resolve) => {
      if (typeof window === 'undefined') {
        resolve();
        return;
      }

      if (window.google) {
        this.setupWebTokenClient();
        resolve();
        return;
      }

      // Check if script already exists
      const existingScript = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
      if (existingScript) {
        // Wait for it to load
        existingScript.addEventListener('load', () => {
          this.setupWebTokenClient();
          resolve();
        });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        this.setupWebTokenClient();
        resolve();
      };
      script.onerror = () => {
        console.error('Failed to load Google Identity Services');
        resolve();
      };
      document.head.appendChild(script);

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!window.google) {
          console.warn('Google Identity Services script loading timeout');
        }
        resolve();
      }, 5000);
    });
  }

  private setupWebTokenClient() {
    if (!window.google?.accounts?.oauth2) {
      console.error('Google Identity Services not loaded');
      return;
    }

    // Validate CLIENT_ID before setting up OAuth client
    if (!CLIENT_ID || CLIENT_ID.trim() === '') {
      console.error('❌ Cannot setup OAuth: CLIENT_ID is missing');
      console.error('Please configure VITE_GOOGLE_CLIENT_ID in your environment variables');
      return;
    }

    const tokenClient = window.google.accounts.oauth2.initCodeClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      ux_mode: 'popup',
      callback: async (response) => {
        if (response.code) {
          await this.exchangeCodeForSession(response.code);
        } else if (response.error) {
          console.error('OAuth error:', response.error);
          throw new Error(response.error_description || response.error);
        }
      },
    });

    // Store for web sign-in
    this.tokenClient = tokenClient;
  }

  private setupAppUrlListener() {
    console.log('🔧 Setting up app URL listener for com.kordn8.shadow://...');
    
    // Test if we can manually trigger a test URL
    console.log('🧪 Testing URL scheme by attempting to open test URL...');
    
    // Also listen for app state changes to detect when app comes back from browser
    App.addListener('appStateChange', async ({ isActive }) => {
      console.log('📱 App state changed, isActive:', isActive);
      if (isActive) {
        console.log('📱 App is now active');
        if (this.processingCallback) {
          console.log('⚠️ App became active while waiting for OAuth callback - appUrlOpen may have been missed');
          // Give it a moment for appUrlOpen to fire if it's going to
          setTimeout(async () => {
            if (this.processingCallback) {
              console.log('❌ Still processing callback but appUrlOpen never fired after becoming active');
              console.log('❌ This means the deep link redirect from Safari failed');
              console.log('❌ Check Safari console for redirect errors');
              try {
                // Try to close browser in case it's still open
                await Browser.close().catch(() => {});
              } catch (e) {
                // Browser might already be closed
              }
            }
          }, 1000);
        }
      }
    });
    
    // Listen for OAuth callback from browser via deep link
    App.addListener('appUrlOpen', async (data) => {
      console.log('🎯 appUrlOpen listener triggered!');
      console.log('📥 Received data:', JSON.stringify(data));
      // Prevent duplicate processing
      if (this.processingCallback) {
        console.log('Already processing callback, ignoring duplicate');
        return;
      }

      try {
        console.log('🔗 Received app URL:', data.url);
        console.log('🔗 Full data object:', JSON.stringify(data));
        
        // Parse URL - handle both com.kordn8.shadow:// and com.kordn8.shadow: formats
        let url: URL;
        let rawUrl = data.url;
        
        try {
          url = new URL(rawUrl);
        } catch (e) {
          console.log('⚠️ URL parsing failed, trying to fix protocol...');
          // If URL parsing fails, try fixing the protocol
          rawUrl = rawUrl.replace(/^com\.kordn8\.shadow:/, 'com.kordn8.shadow://');
          try {
            url = new URL(rawUrl);
          } catch (e2) {
            console.error('❌ Failed to parse URL even after fixing:', e2);
            // Last resort: try to extract params manually
            const urlMatch = rawUrl.match(/com\.kordn8\.shadow:\/\/[^?]+\?(.+)/);
            if (urlMatch) {
              const params = new URLSearchParams(urlMatch[1]);
              console.log('📋 Extracted params manually:', Object.fromEntries(params));
              // Process manually if we have code or error
              if (params.has('code') || params.has('error')) {
                console.log('✅ Found code or error in URL, processing manually...');
                if (params.has('code')) {
                  const code = params.get('code');
                  await Browser.close().catch(() => {});
                  await this.exchangeCodeForSession(code!);
                  this.processingCallback = false;
                  return;
                } else if (params.has('error')) {
                  const error = params.get('error');
                  const errorDescription = params.get('error_description') || error;
                  console.error('OAuth error:', error, errorDescription);
                  await Browser.close().catch(() => {});
                  const err = new Error(errorDescription || 'OAuth error');
                  if ((this as any).signInReject) {
                    (this as any).signInReject(err);
                  }
                  this.processingCallback = false;
                  return;
                }
              }
            }
            return; // Can't parse, give up
          }
        }
        
        console.log('📋 Parsed URL:', { 
          protocol: url.protocol, 
          hostname: url.hostname,
          pathname: url.pathname, 
          search: url.search,
          hasCode: url.searchParams.has('code'),
          hasError: url.searchParams.has('error'),
          fullUrl: data.url 
        });
        
        // Check if this is our OAuth callback deep link
        // Be more lenient with matching - just check if it contains our bundle ID and callback
        const hasOurBundleId = rawUrl.includes('com.kordn8.shadow') || url.protocol.includes('kordn8.shadow');
        const hasCallback = rawUrl.includes('callback') || url.pathname.includes('callback');
        const hasCodeOrError = url.searchParams.has('code') || url.searchParams.has('error');
        
        console.log('🔍 URL matching:', {
          hasOurBundleId, 
          hasCallback, 
          hasCodeOrError,
          protocol: url.protocol,
          pathname: url.pathname
        });
        
        const isOurCallback = hasOurBundleId && (hasCallback || hasCodeOrError);
        
        if (!isOurCallback) {
          console.log('❌ Not our callback, ignoring. Details:', {
            protocol: url.protocol,
            pathname: url.pathname,
            hasOurBundleId,
            hasCallback,
            hasCodeOrError
          });
          return; // Not our callback, ignore
        }
        
        console.log('✅ Confirmed this is our OAuth callback! Processing...');

        this.processingCallback = true;

        if (url.searchParams.has('code')) {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          
          console.log('Processing OAuth callback with code');
          
          // Verify state matches (if provided)
          if (state) {
            const storedState = await Preferences.get({ key: 'oauth_state' });
            if (storedState.value && storedState.value !== state) {
              console.error('Invalid OAuth state');
              await Browser.close().catch(() => {});
              const error = new Error('Invalid OAuth state');
              if ((this as any).signInReject) {
                (this as any).signInReject(error);
              }
              this.processingCallback = false;
              return;
            }
            await Preferences.remove({ key: 'oauth_state' });
          }
          
          // Close browser and exchange code for session
          await Browser.close().catch(() => {});
          await this.exchangeCodeForSession(code!);
          this.processingCallback = false;
        } else if (url.searchParams.has('error')) {
          const error = url.searchParams.get('error');
          const errorDescription = url.searchParams.get('error_description') || error;
          console.error('OAuth error:', error, errorDescription);
          await Browser.close().catch(() => {});
          const err = new Error(errorDescription || 'OAuth error');
          if ((this as any).signInReject) {
            (this as any).signInReject(err);
          }
          this.processingCallback = false;
        }
      } catch (error: any) {
        console.error('Error handling app URL:', error);
        await Browser.close().catch(() => {});
        if ((this as any).signInReject) {
          (this as any).signInReject(new Error('Failed to process OAuth callback: ' + (error.message || 'Unknown error')));
        }
        this.processingCallback = false;
      }
    });
  }

  private async exchangeCodeForSession(code: string): Promise<void> {
    try {
      console.log('Exchanging OAuth code for session...', { codeLength: code.length });
      const data = await apiClient.googleCallback(code);
      console.log('Code exchange response:', { success: data.success, hasUser: !!data.user, error: (data as any).error });
      
      if (data.success && data.user) {
        this.currentUser = data.user;
        this.accessToken = data.access_token || null;
        
        // Store user info in preferences
        await Preferences.set({
          key: 'user',
          value: JSON.stringify(data.user),
        });
        
        // Store session token for Authorization header (cookies may not work in Capacitor)
        if (data.session?.token) {
          await Preferences.set({
            key: 'session_token',
            value: data.session.token,
          });
        }
        
        if (data.access_token) {
          await Preferences.set({
            key: 'access_token',
            value: data.access_token,
          });
        }

        console.log('Sign-in successful, user:', data.user.email);

        // Resolve pending sign-in promise if exists
        if ((this as any).signInResolve) {
          console.log('Resolving sign-in promise');
          (this as any).signInResolve(this.currentUser);
          (this as any).signInResolve = null;
          (this as any).signInReject = null;
        } else {
          console.warn('No signInResolve handler found - sign-in completed but promise may have timed out');
          // Even if promise timed out, user is signed in - trigger app update via event
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('userSignedIn', { detail: this.currentUser }));
          }
        }
      } else {
        const error = new Error((data as any).error || 'Sign in failed');
        console.error('Sign-in failed:', error.message);
        if ((this as any).signInReject) {
          (this as any).signInReject(error);
          (this as any).signInResolve = null;
          (this as any).signInReject = null;
        }
        throw error;
      }
    } catch (error: any) {
      console.error('Error exchanging code:', {
        message: error?.message,
        response: error?.response?.data,
        status: error?.response?.status,
        fullError: error
      });
      
      const errorMessage = error?.response?.data?.details || 
                          error?.response?.data?.error || 
                          error?.message || 
                          'Failed to exchange authorization code';
      
      const finalError = new Error(errorMessage);
      if ((this as any).signInReject) {
        (this as any).signInReject(finalError);
        (this as any).signInResolve = null;
        (this as any).signInReject = null;
      }
      throw finalError;
    }
  }

  async signIn(): Promise<User> {
    // Validate CLIENT_ID before attempting sign-in
    if (!CLIENT_ID || CLIENT_ID.trim() === '') {
      const errorMsg = 'Google OAuth Client ID is not configured. Please set VITE_GOOGLE_CLIENT_ID in your environment variables or .env file.';
      console.error('❌', errorMsg);
      throw new Error(errorMsg);
    }

    if (Capacitor.isNativePlatform()) {
      // Use Browser plugin for native apps (iOS/Android)
      return this.signInWithBrowser();
    } else {
      // Use Google Identity Services for web
      return this.signInWithWeb();
    }
  }

  private async signInWithBrowser(): Promise<User> {
    console.log('Starting Browser OAuth flow...');
    
    // Validate CLIENT_ID before starting OAuth flow
    if (!CLIENT_ID || CLIENT_ID.trim() === '') {
      const errorMsg = 'Google OAuth Client ID is not configured. Please set VITE_GOOGLE_CLIENT_ID in your environment variables.';
      console.error('❌', errorMsg);
      throw new Error(errorMsg);
    }

    // Validate API_URL
    if (!API_URL || API_URL.trim() === '') {
      const errorMsg = 'API URL is not configured. Please set VITE_API_URL in your environment variables.';
      console.error('❌', errorMsg);
      throw new Error(errorMsg);
    }
    
    // Generate a state token for security
    const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    await Preferences.set({ key: 'oauth_state', value: state });
    console.log('Generated OAuth state:', state);

    // Build Google OAuth URL with redirect to backend
    const redirectUri = `${API_URL}/auth/google/mobile-callback`;
    const oauthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&access_type=offline` +
      `&prompt=consent` +
      `&state=${encodeURIComponent(state)}`;

    console.log('Opening OAuth URL in browser...');
    console.log('OAuth URL:', oauthUrl.replace(CLIENT_ID, 'CLIENT_ID_HIDDEN')); // Don't log actual client_id
    console.log('Redirect URI:', redirectUri);
    console.log('Scopes:', SCOPES);
    
    // Open in system browser
    await Browser.open({ url: oauthUrl });

    // Wait for callback via appUrlOpen listener
    return new Promise((resolve, reject) => {
      console.log('Waiting for OAuth callback...');
      
      const timeout = setTimeout(() => {
        console.error('OAuth timeout - no callback received');
        Browser.close().catch(() => {});
        // Check if user was signed in via event (in case promise timed out but callback succeeded)
        const currentUser = this.getCurrentUser();
        if (currentUser) {
          console.log('User was signed in via event, resolving promise');
          resolve(currentUser);
        } else {
          reject(new Error('Sign in timeout. Please try again.'));
        }
        (this as any).signInResolve = null;
        (this as any).signInReject = null;
      }, 300000); // 5 minute timeout

      // Store resolve/reject for use in callback
      (this as any).signInResolve = (user: User) => {
        console.log('OAuth callback resolved, user:', user.email);
        clearTimeout(timeout);
        resolve(user);
        (this as any).signInResolve = null;
        (this as any).signInReject = null;
      };
      (this as any).signInReject = (error: Error) => {
        console.error('OAuth callback rejected:', error.message);
        clearTimeout(timeout);
        reject(error);
        (this as any).signInResolve = null;
        (this as any).signInReject = null;
      };
    });
  }

  private async signInWithWeb(): Promise<User> {
    // Validate CLIENT_ID before starting OAuth flow
    if (!CLIENT_ID || CLIENT_ID.trim() === '') {
      const errorMsg = 'Google OAuth Client ID is not configured. Please set VITE_GOOGLE_CLIENT_ID in your environment variables.';
      console.error('❌', errorMsg);
      throw new Error(errorMsg);
    }

    // Ensure Google Identity Services is loaded
    if (!window.google?.accounts?.oauth2) {
      await this.initializeWebGoogleSignIn();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!window.google?.accounts?.oauth2) {
      throw new Error(
        'Google Sign-In is not available. ' +
        'Please check your internet connection and try again. ' +
        'If the problem persists, try restarting the app.'
      );
    }

    // Setup token client if not already set
    if (!this.tokenClient) {
      this.setupWebTokenClient();
    }

    // Verify token client was set up successfully
    if (!this.tokenClient) {
      throw new Error(
        'Failed to initialize Google OAuth client. ' +
        'Please check that VITE_GOOGLE_CLIENT_ID is correctly configured.'
      );
    }

    const tokenClient = this.tokenClient;
    if (!tokenClient) {
      throw new Error('Failed to initialize Google Sign-In. Please try again.');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Sign in timeout. Please try again.'));
      }, 120000); // 2 minute timeout

      const originalCallback = tokenClient.callback;
      tokenClient.callback = async (response: any) => {
        try {
          clearTimeout(timeout);
          await originalCallback(response);
          if (this.currentUser) {
            resolve(this.currentUser);
          } else {
            reject(new Error('Sign in failed'));
          }
        } catch (error: any) {
          clearTimeout(timeout);
          reject(error);
        }
      };
      
      try {
        tokenClient.requestCode();
      } catch (error: any) {
        clearTimeout(timeout);
        reject(new Error('Failed to start sign-in process: ' + (error.message || 'Unknown error')));
      }
    });
  }

  async addAccount(): Promise<void> {
    if (!window.google?.accounts?.oauth2) {
      await this.initializeWebGoogleSignIn();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!window.google?.accounts?.oauth2) {
      throw new Error('Google Sign-In not available');
    }

    return new Promise((resolve, reject) => {
      const addAccountClient = window.google!.accounts.oauth2.initCodeClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        ux_mode: 'popup',
        callback: async (response: { code?: string; error?: string; error_description?: string }) => {
          if (response.code) {
            try {
              await apiClient.addGoogleAccount(response.code);
              resolve();
            } catch (error) {
              reject(error);
            }
          } else if (response.error) {
            reject(new Error(response.error_description || response.error));
          }
        },
      });
      addAccountClient.requestCode();
    });
  }

  async checkSession(): Promise<User | null> {
    try {
      const data = await apiClient.getCurrentUser();
      this.currentUser = data.user;
      this.accessToken = data.accessToken || null;
      
      // Update stored user info
      await Preferences.set({
        key: 'user',
        value: JSON.stringify(data.user),
      });
      
      return this.currentUser;
    } catch (error) {
      // No valid session
      this.currentUser = null;
      this.accessToken = null;
      await Preferences.remove({ key: 'user' });
      await Preferences.remove({ key: 'access_token' });
      return null;
    }
  }

  async signOut(): Promise<void> {
    try {
      await apiClient.logout();
    } catch (error) {
      console.error('Error signing out:', error);
    } finally {
      this.currentUser = null;
      this.accessToken = null;
      await Preferences.remove({ key: 'user' });
      await Preferences.remove({ key: 'access_token' });
      await Preferences.remove({ key: 'session_token' });
    }
  }

  getCurrentUser(): User | null {
    return this.currentUser;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  async loadStoredUser(): Promise<User | null> {
    try {
      const { value } = await Preferences.get({ key: 'user' });
      if (value) {
        this.currentUser = JSON.parse(value);
        const { value: token } = await Preferences.get({ key: 'access_token' });
        this.accessToken = token || null;
        return this.currentUser;
      }
    } catch (error) {
      console.error('Error loading stored user:', error);
    }
    return null;
  }
}

export const authService = new AuthService();
export default authService;

