import { NextResponse } from "next/server";

import {
  authenticateShellDevice,
  getShellRealtimeConfig,
  normalizeShellDeviceId,
  normalizeShellDeviceToken,
  touchShellDevice,
} from "@/lib/server/shell-push";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    }
    const body = await request.json().catch(() => ({})) as { deviceId?: unknown; deviceToken?: unknown };
    const deviceId = normalizeShellDeviceId(body.deviceId);
    const deviceToken = normalizeShellDeviceToken(body.deviceToken);
    if (!deviceId || !deviceToken || !(await authenticateShellDevice(deviceId, deviceToken))) {
      return NextResponse.json({ ok: false, error: "设备未注册或令牌无效。" }, { status: 401 });
    }
    await touchShellDevice(deviceId, deviceToken);
    const realtime = getShellRealtimeConfig();
    if (!realtime) return NextResponse.json({ ok: false, error: "Realtime 配置未完成。" }, { status: 503 });
    return NextResponse.json({
      ok: true,
      deviceId,
      topic: `shellpush:device:${deviceId}`,
      supabaseUrl: realtime.url,
      anonKey: realtime.anonKey,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
