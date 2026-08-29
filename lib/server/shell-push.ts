import { createHash, randomBytes } from "node:crypto";

import { encodeSupabaseFilter, getSupabaseServerConfig, supabaseRestFetch } from "./supabase-rest";

export type ShellDeviceRegistration = {
  deviceId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
};

type ShellDeviceRow = {
  device_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  enabled: boolean;
};

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

export function normalizeShellDeviceId(value: unknown): string {
  const deviceId = typeof value === "string" ? value.trim() : "";
  return DEVICE_ID_PATTERN.test(deviceId) ? deviceId : "";
}

export function normalizeShellDeviceToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  return /^[a-fA-F0-9]{64,128}$/.test(token) ? token : "";
}

export function hashShellDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createShellDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

export async function registerShellDevice(
  deviceId: string,
  token: string,
): Promise<ShellDeviceRegistration> {
  const now = new Date().toISOString();
  const tokenHash = hashShellDeviceToken(token);
  const result = await supabaseRestFetch<ShellDeviceRow[]>("shell_devices", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([{
      device_id: deviceId,
      token_hash: tokenHash,
      enabled: true,
      last_seen_at: now,
    }]),
  });
  if (!result.ok) throw new Error(result.error);
  const row = result.data[0];
  if (!row) throw new Error("设备注册没有返回设备记录。");
  return {
    deviceId: row.device_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function authenticateShellDevice(deviceId: string, token: string): Promise<boolean> {
  const result = await supabaseRestFetch<ShellDeviceRow[]>(
    `shell_devices?device_id=eq.${encodeSupabaseFilter(deviceId)}&token_hash=eq.${encodeSupabaseFilter(hashShellDeviceToken(token))}&enabled=eq.true&select=device_id,token_hash,created_at,last_seen_at,enabled&limit=1`,
  );
  return result.ok && result.data.length > 0;
}

export async function touchShellDevice(deviceId: string, token: string): Promise<boolean> {
  const authenticated = await authenticateShellDevice(deviceId, token);
  if (!authenticated) return false;
  const result = await supabaseRestFetch(
    `shell_devices?device_id=eq.${encodeSupabaseFilter(deviceId)}`,
    { method: "PATCH", body: JSON.stringify({ last_seen_at: new Date().toISOString() }) },
  );
  return result.ok;
}

export function getShellRealtimeConfig(): { url: string; anonKey: string } | null {
  const config = getSupabaseServerConfig();
  const anonKey = (process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!config || !anonKey) return null;
  return { url: config.url, anonKey };
}
