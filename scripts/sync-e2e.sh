#!/usr/bin/env bash
# 本地设计同步端到端：临时 DB 起 material-flow 后端 → 建机台/密钥 → Node 跑打包/上传/列表/diff/下载/断网断言。
# 幂等：每次使用新的临时数据目录；失败时保留目录便于查日志，成功时清理。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${MATERIAL_FLOW_BACKEND:-/root/mf-main/material-flow-backend}"
PORT="${SYNC_E2E_PORT:-8899}"
BASE_URL="http://127.0.0.1:${PORT}"
WORK_DIR="${SYNC_E2E_WORK_DIR:-/tmp/automation-cad-sync-e2e}"
PYTHON="$BACKEND_DIR/.venv/bin/python"
ADMIN_USER="owlco"
ADMIN_PASSWORD_INITIAL="SyncE2E@2026-init"
ADMIN_PASSWORD_FINAL="SyncE2E@2026-final"
DEVICE_NO="DEV-TEST-01"

log() { printf '[sync-e2e] %s\n' "$*"; }
die() { printf '[sync-e2e] ERROR: %s\n' "$*" >&2; exit 1; }

json_field() {
  "$PYTHON" -c 'import json,sys; data=json.load(sys.stdin); print(data.get(sys.argv[1], ""))' "$1"
}

cleanup() {
  local status=$?
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  if [[ "$status" -eq 0 && "${SYNC_E2E_KEEP:-0}" != "1" ]]; then
    rm -rf "$WORK_DIR"
  elif [[ -d "$WORK_DIR" ]]; then
    log "保留临时目录：$WORK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[[ -x "$PYTHON" ]] || die "找不到后端 venv：$PYTHON"
command -v node >/dev/null 2>&1 || die "找不到 node"
command -v curl >/dev/null 2>&1 || die "找不到 curl"
[[ -n "$WORK_DIR" && "$WORK_DIR" != "/" ]] || die "SYNC_E2E_WORK_DIR 不能为空或 /"

if [[ -f "$WORK_DIR/backend.pid" ]]; then
  OLD_PID="$(cat "$WORK_DIR/backend.pid" 2>/dev/null || true)"
  if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" 2>/dev/null; then
    log "清理上次遗留的后端进程 $OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/data" "$WORK_DIR/uploads"

if curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1; then
  die "端口 $PORT 已被其他进程占用；请先停止该进程或设置 SYNC_E2E_PORT"
fi

log "启动后端 $BACKEND_DIR（端口 $PORT，临时数据 $WORK_DIR）"
(
  cd "$BACKEND_DIR"
  exec env \
    MATERIAL_FLOW_DATA="$WORK_DIR/data" \
    MATERIAL_FLOW_UPLOADS="$WORK_DIR/uploads" \
    INITIAL_ADMIN_PASSWORD="$ADMIN_PASSWORD_INITIAL" \
    PYTHONUNBUFFERED=1 \
    "$PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT"
) >"$WORK_DIR/backend.log" 2>&1 &
BACKEND_PID=$!
printf '%s\n' "$BACKEND_PID" >"$WORK_DIR/backend.pid"

for _ in $(seq 1 120); do
  if curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    tail -80 "$WORK_DIR/backend.log" >&2 || true
    die "后端启动失败"
  fi
  sleep 0.25
done
curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1 || {
  tail -80 "$WORK_DIR/backend.log" >&2 || true
  die "后端 30 秒内未就绪"
}
log "后端已就绪"

log "管理员登录并清除初始改密标记"
LOGIN_JSON="$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD_INITIAL\",\"deviceId\":\"sync-e2e-setup\"}")"
TOKEN="$(printf '%s' "$LOGIN_JSON" | json_field accessToken)"
[[ -n "$TOKEN" ]] || die "管理员登录失败：$LOGIN_JSON"

CHANGE_BODY="$WORK_DIR/change-password.json"
CHANGE_CODE="$(curl -sS -o "$CHANGE_BODY" -w '%{http_code}' -X POST "$BASE_URL/api/v1/auth/change-password" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"oldPassword\":\"$ADMIN_PASSWORD_INITIAL\",\"newPassword\":\"$ADMIN_PASSWORD_FINAL\"}")"
[[ "$CHANGE_CODE" == "200" ]] || die "修改初始密码失败（$CHANGE_CODE）：$(cat "$CHANGE_BODY")"

LOGIN_JSON="$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD_FINAL\",\"deviceId\":\"sync-e2e-setup\"}")"
TOKEN="$(printf '%s' "$LOGIN_JSON" | json_field accessToken)"
[[ -n "$TOKEN" ]] || die "改密后管理员登录失败：$LOGIN_JSON"

log "创建测试机台 $DEVICE_NO（走 /api/v1/devices）"
OP_ID="$("$PYTHON" -c 'import uuid; print(uuid.uuid4())')"
REQ_ID="$("$PYTHON" -c 'import uuid; print(uuid.uuid4())')"
DEVICE_CODE="$(curl -sS -o "$WORK_DIR/device.json" -w '%{http_code}' -X POST "$BASE_URL/api/v1/devices" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H "X-Request-Id: $REQ_ID" \
  -H "Idempotency-Key: $OP_ID" \
  -d "{\"clientOperationId\":\"$OP_ID\",\"deviceNo\":\"$DEVICE_NO\",\"deviceName\":\"设计同步测试机台\",\"workshop\":\"E2E\"}")"
case "$DEVICE_CODE" in
  200|201) ;;
  409)
    curl -fsS "$BASE_URL/api/v1/devices/$DEVICE_NO" -H "Authorization: Bearer $TOKEN" >/dev/null \
      || die "机台已存在但查询失败"
    ;;
  *) die "创建机台失败（$DEVICE_CODE）：$(cat "$WORK_DIR/device.json")" ;;
esac

log "通过管理台接口生成 X-Design-Key"
COOKIE_JAR="$WORK_DIR/cookies.txt"
LOGIN_PAGE="$(curl -sS -c "$COOKIE_JAR" "$BASE_URL/admin/login")"
ANON_CSRF="$(printf '%s' "$LOGIN_PAGE" | grep -o 'name="csrf_token" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"$//')"
[[ -n "$ANON_CSRF" ]] || die "管理台登录页缺少 CSRF"
WEB_LOGIN_CODE="$(curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" -o /dev/null -w '%{http_code}' \
  -X POST "$BASE_URL/admin/login" \
  --data-urlencode "username=$ADMIN_USER" \
  --data-urlencode "password=$ADMIN_PASSWORD_FINAL" \
  --data-urlencode "csrf_token=$ANON_CSRF")"
[[ "$WEB_LOGIN_CODE" == "303" ]] || die "管理台登录失败（$WEB_LOGIN_CODE）"

DESIGN_PAGE="$(curl -sS -b "$COOKIE_JAR" "$BASE_URL/admin/design-packages")"
CSRF="$(printf '%s' "$DESIGN_PAGE" | grep -o 'name="csrf_token" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"$//')"
[[ -n "$CSRF" ]] || die "设计包页缺少 CSRF"
KEY_PAGE="$WORK_DIR/key.html"
KEY_CODE="$(curl -sS -b "$COOKIE_JAR" -o "$KEY_PAGE" -w '%{http_code}' \
  -X POST "$BASE_URL/admin/design-packages/keys/create" \
  --data-urlencode "csrf_token=$CSRF" \
  --data-urlencode "label=sync-e2e" \
  --data-urlencode "device_scope=$DEVICE_NO" \
  --data-urlencode "ip_scope=127.0.0.0/8")"
[[ "$KEY_CODE" == "200" ]] || die "生成设计密钥失败（$KEY_CODE）"
DESIGN_KEY="$(grep -o 'value="mfds_[^"]*"' "$KEY_PAGE" | head -1 | sed 's/^value="//;s/"$//')"
[[ -n "$DESIGN_KEY" ]] || die "未能从管理台响应中解析 X-Design-Key"

log "执行 Node 端到端链路（打包 / 上传 / 列表 / diff / 下载 / 断网）"
SYNC_E2E_BASE_URL="$BASE_URL" \
SYNC_E2E_API_KEY="$DESIGN_KEY" \
SYNC_E2E_DEVICE_ID="$DEVICE_NO" \
SYNC_E2E_PROJECT_ID="asm-sync-e2e" \
SYNC_E2E_BACKEND_PID="$BACKEND_PID" \
node "$ROOT/desktop/scripts/sync-e2e.mjs"
