import { PushNotifications } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { Meeting } from '../types';

class NotificationService {
  private isInitialized = false;
  private deviceToken: string | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized || !Capacitor.isNativePlatform()) {
      return;
    }

    try {
      // Request permission
      let permStatus = await PushNotifications.checkPermissions();

      if (permStatus.receive === 'prompt') {
        permStatus = await PushNotifications.requestPermissions();
      }

      if (permStatus.receive !== 'granted') {
        console.warn('Push notification permission not granted');
        return;
      }

      // Register for push notifications
      await PushNotifications.register();

      // Listen for registration
      PushNotifications.addListener('registration', (token) => {
        console.log('Push registration success, token: ' + token.value);
        this.deviceToken = token.value;
        this.saveDeviceToken(token.value);
      });

      // Listen for registration errors
      PushNotifications.addListener('registrationError', (error) => {
        console.error('Error on registration: ' + JSON.stringify(error));
      });

      // Listen for push notifications received
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        console.log('Push notification received: ', notification);
      });

      // Listen for push notification actions
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        console.log('Push notification action performed', action);
      });

      this.isInitialized = true;
    } catch (error) {
      console.error('Error initializing notifications:', error);
    }
  }

  private async saveDeviceToken(token: string): Promise<void> {
    await Preferences.set({
      key: 'device_token',
      value: token,
    });
  }

  async getDeviceToken(): Promise<string | null> {
    if (this.deviceToken) {
      return this.deviceToken;
    }

    try {
      const { value } = await Preferences.get({ key: 'device_token' });
      return value || null;
    } catch {
      return null;
    }
  }

  async scheduleMeetingReminder(
    meeting: Meeting,
    minutesBefore: number = 15
  ): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      // For web, use browser notifications
      this.scheduleWebNotification(meeting, minutesBefore);
      return;
    }

    const startTime = meeting.start?.dateTime
      ? new Date(meeting.start.dateTime)
      : meeting.start?.date
      ? new Date(meeting.start.date)
      : null;

    if (!startTime) {
      console.warn('Cannot schedule reminder: no start time');
      return;
    }

    const reminderTime = new Date(startTime.getTime() - minutesBefore * 60 * 1000);
    const now = new Date();

    if (reminderTime <= now) {
      console.warn('Reminder time is in the past');
      return;
    }

    // Schedule local notification
    // Note: Capacitor Push Notifications plugin doesn't support scheduling
    // For scheduling, we'd need to use a native plugin or handle server-side
    // For now, we'll store the reminder info and handle it server-side or via background task
    await this.saveReminder(meeting.id, reminderTime, minutesBefore);
  }

  private async scheduleWebNotification(
    meeting: Meeting,
    minutesBefore: number
  ): Promise<void> {
    if (!('Notification' in window)) {
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return;
    }

    const startTime = meeting.start?.dateTime
      ? new Date(meeting.start.dateTime)
      : meeting.start?.date
      ? new Date(meeting.start.date)
      : null;

    if (!startTime) {
      return;
    }

    const reminderTime = new Date(startTime.getTime() - minutesBefore * 60 * 1000);
    const now = new Date();
    const delay = reminderTime.getTime() - now.getTime();

    if (delay <= 0) {
      return;
    }

    setTimeout(() => {
      new Notification(meeting.summary || meeting.title || 'Meeting', {
        body: `Your meeting starts in ${minutesBefore} minutes`,
        icon: '/icon.png',
        tag: `meeting-${meeting.id}`,
      });
    }, delay);
  }

  private async saveReminder(
    meetingId: string,
    reminderTime: Date,
    minutesBefore: number
  ): Promise<void> {
    const reminders = await this.getReminders();
    reminders.push({
      meetingId,
      reminderTime: reminderTime.toISOString(),
      minutesBefore,
    });
    await Preferences.set({
      key: 'meeting_reminders',
      value: JSON.stringify(reminders),
    });
  }

  private async getReminders(): Promise<
    Array<{ meetingId: string; reminderTime: string; minutesBefore: number }>
  > {
    try {
      const { value } = await Preferences.get({ key: 'meeting_reminders' });
      return value ? JSON.parse(value) : [];
    } catch {
      return [];
    }
  }

  async scheduleDailySummary(hour: number = 8, minute: number = 0): Promise<void> {
    // Store preference for daily summary time
    await Preferences.set({
      key: 'daily_summary_time',
      value: JSON.stringify({ hour, minute }),
    });
  }

  async sendNotification(title: string, body: string, data?: any): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
          body,
          icon: '/icon.png',
          data,
        });
      }
      return;
    }

    // For native, notifications are handled by the system
    // This would typically be done server-side via APNs
    console.log('Notification:', { title, body, data });
  }
}

export const notificationService = new NotificationService();
export default notificationService;

