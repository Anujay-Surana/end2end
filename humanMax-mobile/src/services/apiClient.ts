import axios, { AxiosError } from 'axios';
import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { Capacitor } from '@capacitor/core';
import type {
  AuthResponse,
  AccountsResponse,
  MeetingsResponse,
  MeetingPrepResponse,
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

    // Request interceptor for adding auth tokens if needed
    this.client.interceptors.request.use(
      async (config) => {
        // Session cookies are handled automatically with withCredentials
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

  async prepMeeting(meeting: any, attendees: any[], accessToken?: string): Promise<MeetingPrepResponse> {
    try {
      const response = await this.client.post<MeetingPrepResponse>('/api/prep-meeting', {
        meeting,
        attendees,
        accessToken,
      });
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }

  async dayPrep(date: string): Promise<DayPrepResponse> {
    try {
      const response = await this.client.post<DayPrepResponse>('/api/day-prep', { date });
      return response.data;
    } catch (error) {
      return this.handleError(error as AxiosError<ApiError>);
    }
  }
}

export const apiClient = new ApiClient();
export default apiClient;

