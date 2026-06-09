export type SupervisorNotificationLevel = "now" | "daily" | "drop";

export interface SupervisorNotification {
  level: SupervisorNotificationLevel;
  title: string;
  body: string;
  reason: string;
}
