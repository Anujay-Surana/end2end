import axios, { AxiosError } from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Capacitor } from '@capacitor/core';
import type {
  AuthResponse,
  AccountsResponse,
  MeetingsResponse,
  DayPrepResponse,
  ApiError,
  Account,
} from '../types';

// For device testing, use your Mac's IP address instead of localhost
// Find your Mac's IP: ifconfig | grep "inet " | grep -v 127.0.0.1
// Or use your Mac's hostname.local (e.g., anujay-mac.local)
const getApiBaseUrl = () => {
  // Use environment variable if set, otherwise fallback to Railway production URL
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  
  if (Capacitor.isNativePlatform()) {
    // For production, use Railway HTTPS URL
    return 'https://end2end-production.up.railway.app';
  }
  
  // For local development
  return 'http://localhost:8080';
};

const API_BASE_URL = getApiBaseUrl();

class ApiClient {
  private client: AxiosInstance;
  private retryDelay = 1000;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      withCredentials: true, // Important for session cookies
      timeout: 10000, // 10 second timeout to prevent indefinite waiting
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor for adding auth tokens
    this.client.interceptors.request.use(
      async (config) => {
        // For Capacitor apps, cookies may not work reliably
        // Use Authorization header with session token instead
        if (Capacitor.isNativePlatform()) {
          try {
            const { Preferences } = await import('@capacitor/preferences');
            const { value: sessionToken } = await Preferences.get({ key: 'session_token' });
            if (sessionToken) {
              config.headers = config.headers || {};
              config.headers['Authorization'] = `Bearer ${sessionToken}`;
            }
          } catch (error) {
            console.warn('Failed to get session token for request:', error);
          }
        }
        // Session cookies are handled automatically with withCredentials for web
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptor for error handling and retries
    this.client.interceptors.response.use(
      (response) => response,
      async (error: AxiosError<ApiError>) => {
        const config = error.config as AxiosRequestConfig & { _retry?: boolean };

        // Don't retry if already retried or if it's a client error (4xx)
        if (
          config._retry ||
          !config ||
          (error.response && error.response.status && error.response.status < 500)
        ) {
          return Promise.reject(error);
        }

        // Retry logic for server errors
        if (!config._retry && error.response?.status && error.response.status >= 500) {
          config._retry = true;
          await this.delay(this.retryDelay);
          return this.client(config);
        }

        return Promise.reject(error);
      }
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async handleError(error: AxiosError<ApiError>): Promise<never> {
    console.error('API Error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message,
    });
    
    if (error.response) {
      // Server responded with error
      const errorMessage = error.response.data?.message || error.response.data?.error || 'An error occurred';
      throw new Error(errorMessage);
    } else if (error.request) {
      // Request made but no response
      throw new Error('Network error. Please check your connection.');
    } else {
      // Something else happened
      throw new Error(error.message || 'An unexpected error occurred');
    }
  }

  // Auth endpoints
  async googleCallback(code: string): Promise<AuthResponse> {
    try {
      // Add header to indicate this is a mobile request
      const config: AxiosRequestConfig = {};
      if (Capacitor.isNativePlatform()) {
        config.headers = {
          'X-Capacitor-Platform': Capacitor.getPlatform(),
        };
      }
      const response = await this.client.post<AuthResponse>('/auth/google/callback', { code }, config);
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async addGoogleAccount(code: string): Promise<AuthResponse> {
    try {
      const response = await this.client.post<AuthResponse>('/auth/google/add-account', { code });
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async getCurrentUser(): Promise<{ user: AuthResponse['user']; accessToken?: string }> {
    try {
      const response = await this.client.get<{ user: AuthResponse['user']; accessToken?: string }>('/auth/me');
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async logout(): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.client.post<{ success: boolean; message?: string }>('/auth/logout');
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  // Account endpoints
  async getAccounts(): Promise<AccountsResponse> {
    try {
      const response = await this.client.get<AccountsResponse>('/api/accounts');
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async deleteAccount(accountId: string): Promise<{ success: boolean; message?: string }> {
    try {
      const response = await this.client.delete<{ success: boolean; message?: string }>(`/api/accounts/${accountId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async setPrimaryAccount(accountId: string): Promise<{ success: boolean; message?: string; account?: Account }> {
    try {
      const response = await this.client.put<{ success: boolean; message?: string; account?: Account }>(
        `/api/accounts/${accountId}/set-primary`
      );
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  // Meeting endpoints
  async getMeetingsForDay(date: string): Promise<MeetingsResponse> {
    try {
      const response = await this.client.get<MeetingsResponse>('/api/meetings-for-day', {
        params: { date },
      });
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  /**
   * Helper function to read streaming response from /api/prep-meeting
   * Reads newline-delimited JSON chunks and handles progress updates
   */
  private async readStreamingPrepResponse(
    response: Response,
    onProgress?: (chunk: any) => void
  ): Promise<any> {
    if (!response.ok) {
      let errorMessage = `Server error: ${response.status}`;
      let errorDetails: any = null;

      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorMessage;
        errorDetails = errorData;

        // Check for revoked token error
        if (
          response.status === 401 &&
          (errorData.error === 'TokenRevoked' || errorData.revoked === true)
        ) {
          throw new Error('Your session has expired. Please sign in again.');
        }
      } catch (parseError) {
        try {
          const errorText = await response.text();
          errorMessage = errorText || errorMessage;
        } catch (textError) {
          // Ignore
        }
      }

      const error = new Error(errorMessage) as any;
      error.status = response.status;
      error.details = errorDetails;
      throw error;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const chunk = JSON.parse(line);

            if (chunk.type === 'progress') {
              // Handle progress updates
              if (onProgress) {
                onProgress(chunk);
              }
              console.log('📊 Progress:', chunk.step, chunk.data?.message || '');
            } else if (chunk.type === 'complete') {
              // Return final result (chunk contains all brief fields)
              const brief = { ...chunk };
              delete brief.type; // Remove type field
              return brief;
            } else if (chunk.type === 'error') {
              // Handle error chunks
              const error = new Error(chunk.message || chunk.error || 'Unknown error') as any;
              error.status = chunk.statusCode || 500;
              error.details = chunk;
              throw error;
            }
          } catch (parseError) {
            console.warn('Failed to parse chunk:', parseError, 'Line:', line.substring(0, 100));
            // Continue processing other chunks
          }
        }
      }

      // If we exit the loop without getting a 'complete' chunk, check buffer
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer);
          if (chunk.type === 'complete') {
            const brief = { ...chunk };
            delete brief.type;
            return brief;
          }
        } catch (e) {
          console.warn('Failed to parse final buffer:', e);
        }
      }

      throw new Error('Stream ended without complete result');
    } finally {
      reader.releaseLock();
    }
  }

  async prepMeeting(meeting: any, attendees: any[], accessToken?: string): Promise<any> {
    try {
      // Use fetch API for streaming support (Axios doesn't handle streaming well)
      // Prep meeting can take 2+ minutes, backend streams response to prevent timeout
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add auth token for mobile if available
      if (Capacitor.isNativePlatform()) {
        try {
          const { Preferences } = await import('@capacitor/preferences');
          const { value: sessionToken } = await Preferences.get({ key: 'session_token' });
          if (sessionToken) {
            headers['Authorization'] = `Bearer ${sessionToken}`;
          }
        } catch (error) {
          console.warn('Failed to get session token for request:', error);
        }
      }

      const response = await fetch(`${API_BASE_URL}/api/prep-meeting`, {
        method: 'POST',
        headers,
        credentials: Capacitor.isNativePlatform() ? undefined : 'include',
        body: JSON.stringify({
          meeting,
          attendees,
          accessToken,
        }),
      });

      // Read streaming response
      return await this.readStreamingPrepResponse(response);
    } catch (error: any) {
      // Convert fetch errors to match Axios error format for handleError
      if (error instanceof Error) {
        const axiosError = {
          response: {
            status: error.status || 500,
            data: error.details || { message: error.message },
          },
          message: error.message,
        } as AxiosError<ApiError>;
        return this.handleError(axiosError);
      }
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async dayPrep(date: string): Promise<DayPrepResponse> {
    try {
      // Day prep can also take a long time, use longer timeout (5 minutes = 300000ms)
      const response = await this.client.post<DayPrepResponse>(
        '/api/day-prep',
        { date },
        {
          timeout: 300000, // 5 minutes for day prep generation
        }
      );
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }
}

export const apiClient = new ApiClient();
export default apiClient;

