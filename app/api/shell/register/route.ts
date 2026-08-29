import { NextResponse } from "next/server";

import {
  createShellDeviceToken,
  normalizeShellDeviceId,
  normalizeShellDeviceToken,
  registerShellDevice,
} from "@/lib/server/shell-push";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const body = await request.json().catch(() => ({})) as { deviceId?: unknown; deviceToken?: unknown };
    const deviceId = normalizeShellDeviceId(body.deviceId);
    const suppliedToken = normalizeShellDeviceToken(body.deviceToken);
    if (!deviceId) return NextResponse.json({ ok: false, error: "设备 ID 无效。" }, { status: 400 });
    const deviceToken = suppliedToken || createShellDeviceToken();
    const device = await registerShellDevice(deviceId, deviceToken);
    return NextResponse.json({ ok: true, deviceId: device.deviceId, deviceToken, registeredAt: device.createdAt });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
