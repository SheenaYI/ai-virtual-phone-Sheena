import { NextResponse } from "next/server";

import { broadcastShellDeviceNotify } from "@/lib/server/push-service";
import { authenticateShellDevice, normalizeShellDeviceId, normalizeShellDeviceToken } from "@/lib/server/shell-push";
import { formatSupabaseRestError, getSupabaseServerConfig } from "@/lib/server/supabase-rest";

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置。" }, { status: 503 });
    const body = await request.json().catch(() => ({})) as { deviceId?: unknown; deviceToken?: unknown };
    const deviceId = normalizeShellDeviceId(body.deviceId);
    const deviceToken = normalizeShellDeviceToken(body.deviceToken);
    if (!deviceId || !deviceToken || !(await authenticateShellDevice(deviceId, deviceToken))) {
      return NextResponse.json({ ok: false, error: "设备未注册或令牌无效。" }, { status: 401 });
    }
    const sent = await broadcastShellDeviceNotify(deviceId, {
      title: "小手机",
      body: "单机 APK 推送已连通。",
      url: new URL("/", request.url).toString(),
    });
    return sent
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ ok: false, error: "Realtime 广播失败。" }, { status: 502 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) }, { status: 500 });
  }
}
