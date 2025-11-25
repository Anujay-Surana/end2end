import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { apiClient } from './apiClient';
import type { Meeting } from '../types';

class BackgroundSyncService {
  private syncInProgress = false;
  private lastSyncTime: Date | null = null;

  async initialize(): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      return;
    }

    // Listen for app state changes
    App.addListener('appStateChange', async ({ isActive }) => {
      if (isActive && !this.syncInProgress) {
        // App came to foreground - sync data
        await this.syncCalendarData();
      }
    });
  }

  async syncCalendarData(): Promise<void> {
    if (this.syncInProgress) {
      return;
    }

    this.syncInProgress = true;

    try {
      // Check if user is authenticated by trying to get user info
      // If this fails, user is not authenticated, so skip sync
      try {
        await apiClient.getCurrentUser();
      } catch (authError) {
        // User not authenticated, skip sync
        return;
      }

      const today = new Date();
      const dateStr = this.formatDate(today);
      
      // Fetch today's meetings
      const response = await apiClient.getMeetingsForDay(dateStr);
      
      // Cache the meetings
      await this.cacheMeetings(dateStr, response.meetings);
      
      this.lastSyncTime = new Date();
      await Preferences.set({
        key: 'last_sync_time',
        value: this.lastSyncTime.toISOString(),
      });
    } catch (error: any) {
      // Only log if it's not an authentication error
      if (error?.response?.status !== 401 && error?.response?.status !== 403) {
        console.error('Error syncing calendar data:', error?.message || error);
      }
    } finally {
      this.syncInProgress = false;
    }
  }

  async getCachedMeetings(date: string): Promise<Meeting[]> {
    try {
      const { value } = await Preferences.get({ key: `meetings_${date}` });
      return value ? JSON.parse(value) : [];
    } catch {
      return [];
    }
  }

  private async cacheMeetings(date: string, meetings: Meeting[]): Promise<void> {
    await Preferences.set({
      key: `meetings_${date}`,
      value: JSON.stringify(meetings),
    });
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  async getLastSyncTime(): Promise<Date | null> {
    try {
      const { value } = await Preferences.get({ key: 'last_sync_time' });
      return value ? new Date(value) : null;
    } catch {
      return null;
    }
  }

  async shouldSync(): Promise<boolean> {
    const lastSync = await this.getLastSyncTime();
    if (!lastSync) {
      return true;
    }

    const now = new Date();
    const diffMinutes = (now.getTime() - lastSync.getTime()) / (1000 * 60);
    
    // Sync if last sync was more than 15 minutes ago
    return diffMinutes > 15;
  }
}

export const backgroundSyncService = new BackgroundSyncService();
export default backgroundSyncService;

