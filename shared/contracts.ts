export const MAX_FILE_SIZE = 500_000_000;
export const PART_SIZE = 8 * 1024 * 1024;
export const UPLOAD_TTL = 24 * 60 * 60 * 1000;
export const LOCK_MS = 60_000;
export const TICKET_MS = 60_000;
export const LEASE_MS = 180_000;
export const HEARTBEAT_MS = 60_000;

export interface SiteLimits {
  maxStoredBytes: number;
  maxActiveFiles: number;
  uploadsPerDay: number;
  downloadsPerDay: number;
  downloadsPerMonth: number;
  r2ClassAPerDay: number;
  r2ClassAPerMonth: number;
  r2ClassBPerDay: number;
  r2ClassBPerMonth: number;
  maxPartAttempts: number;
  maxCompleteAttempts: number;
}

export interface PublicConfig {
  uploadAuthMode: 'google' | 'password' | 'none';
  uploadEmail: string | null;
  googleLoginOrigin: string | null;
  uploadPasswordRequired: boolean;
  uploadAuthenticated: boolean;
  uploadConfigured: boolean;
  maxFileSize: number;
  partSize: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  defaultDownloads: number;
  maxDownloads: number;
  serverTime: number;
  uploadBlockedUntil: number;
  downloadBlockedUntil: number;
  siteLimits: SiteLimits;
}

export interface CreateUpload {
  name: string;
  size: number;
  code: string;
  ttlSeconds: number;
  downloads: number;
}

export interface UploadSession {
  id: string;
  token: string;
  partSize: number;
  partCount: number;
}

export interface UploadResult {
  name: string;
  size: number;
  expiresAt: number;
  downloads: number;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  retryAfter?: number;
}
