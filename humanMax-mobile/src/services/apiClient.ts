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
    const url = import.meta.env.VITE_API_URL;
    console.log(`[API Client] Using API URL from env: ${url}`);
    return url;
  }
  
  if (Capacitor.isNativePlatform()) {
    // For production, use Railway HTTPS URL
    const url = 'https://end2end-production.up.railway.app';
    console.log(`[API Client] Using Railway production URL: ${url}`);
    return url;
  }
  
  // For local development
  const url = 'http://localhost:8080';
  console.log(`[API Client] Using localhost URL: ${url}`);
  return url;
};

const API_BASE_URL = getApiBaseUrl();
console.log(`[API Client] Final API Base URL: ${API_BASE_URL}`);

class ApiClient {
  private client: AxiosInstance;
  private retryDelay = 1000;

  constructor() {
    console.log(`[API Client] Initializing with baseURL: ${API_BASE_URL}`);
    console.log(`[API Client] Platform: ${Capacitor.getPlatform()}`);
    console.log(`[API Client] Is Native: ${Capacitor.isNativePlatform()}`);
    
    this.client = axios.create({
      baseURL: API_BASE_URL,
      // Only use credentials for web (cookies work there)
      // For mobile, we use Authorization header instead (set in interceptor)
      withCredentials: !Capacitor.isNativePlatform(),
      timeout: 30000, // 30 second timeout for mobile networks which can be slower
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
          // Add platform header for backend to identify mobile requests
          config.headers = config.headers || {};
          config.headers['X-Capacitor-Platform'] = Capacitor.getPlatform();
          
          try {
            const { Preferences } = await import('@capacitor/preferences');
            const { value: sessionToken } = await Preferences.get({ key: 'session_token' });
            if (sessionToken) {
              config.headers['Authorization'] = `Bearer ${sessionToken}`;
            }
          } catch (error) {
            console.warn('Failed to get session token for request:', error);
          }
          
          // Log request details for debugging
          console.log(`[API Client] Making ${config.method?.toUpperCase()} request to ${config.url}`, {
            hasAuth: !!config.headers['Authorization'],
            platform: Capacitor.getPlatform(),
            baseURL: config.baseURL,
          });
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
        const config = error.config as AxiosRequestConfig & { _retry?: boolean; _retryCount?: number };
        
        // Initialize retry count
        const retryCount = config._retryCount || 0;
        const maxRetries = 3;

        // Don't retry if:
        // - Already retried max times
        // - It's a client error (4xx) that's not 401/408/429
        // - No config available
        if (
          !config ||
          retryCount >= maxRetries ||
          (error.response && error.response.status && error.response.status < 500 && 
           ![401, 408, 429].includes(error.response.status))
        ) {
          return Promise.reject(error);
        }

        // Retry on:
        // - Network errors (ERR_NETWORK) - common on mobile when network isn't ready
        // - Server errors (5xx)
        // - Specific client errors (408 timeout, 429 rate limit)
        const shouldRetry = 
          (!error.response && (error.code === 'ERR_NETWORK' || error.message.includes('Network Error'))) ||
          (error.response?.status && error.response.status >= 500) ||
          (error.response?.status && [408, 429].includes(error.response.status));

        if (shouldRetry && retryCount < maxRetries) {
          config._retryCount = retryCount + 1;
          // Exponential backoff: 1s, 2s, 4s
          const delayMs = this.retryDelay * Math.pow(2, retryCount);
          console.log(`[API Client] Retrying request (attempt ${retryCount + 1}/${maxRetries}) after ${delayMs}ms...`);
          await this.delay(delayMs);
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
      code: error.code,
      url: error.config?.url,
      baseURL: error.config?.baseURL,
    });
    
    if (error.response) {
      // Server responded with error
      const errorMessage = error.response.data?.message || error.response.data?.error || 'An error occurred';
      throw new Error(errorMessage);
    } else if (error.request) {
      // Request made but no response
      // Check if it's a timeout
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      // Check if it's a network error
      if (error.code === 'ERR_NETWORK' || error.message.includes('Network Error')) {
        const apiUrl = API_BASE_URL;
        // Provide more helpful error message for network issues
        const isRailway = apiUrl.includes('railway.app');
        const errorMsg = isRailway
          ? `Cannot connect to Railway server. Please check:\n1. Your internet connection (try WiFi instead of cellular)\n2. Open ${apiUrl} in Safari to test connectivity\n3. Check if Railway is accessible from your network`
          : `Cannot connect to server at ${apiUrl}. Please check your connection and ensure the server is running.`;
        throw new Error(errorMsg);
      }
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
            status: (error as any).status || 500,
            data: (error as any).details || { message: error.message },
          },
          message: error.message,
        } as AxiosError<ApiError>;
        return this.handleError(axiosError);
      }
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  // Chat endpoints
  async getChatMessages(meetingId?: string, limit: number = 100): Promise<any> {
    try {
      const params: any = { limit };
      if (meetingId) {
        params.meeting_id = meetingId;
      }
      const response = await this.client.get('/api/chat/messages', { params });
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async sendChatMessage(message: string, meetingId?: string): Promise<any> {
    try {
      const response = await this.client.post('/api/chat/messages', {
        message,
        meeting_id: meetingId,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async deleteChatMessage(messageId: string): Promise<any> {
    try {
      const response = await this.client.delete(`/api/chat/messages/${messageId}`);
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  // Device registration
  async registerDevice(deviceToken: string, platform: string = 'ios', timezone: string = 'UTC', deviceInfo?: any): Promise<any> {
    try {
      const response = await this.client.post('/api/devices/register', {
        device_token: deviceToken,
        platform,
        timezone,
        device_info: deviceInfo,
      });
      return response.data;
    } catch (error) {
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

