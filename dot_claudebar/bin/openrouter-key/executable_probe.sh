#!/bin/sh
# ClaudeBar custom provider "openrouter-key": spend of one OpenRouter API key.
# No arguments: print the usage payload {"caps", optional "credits_remaining"} for CLAUDEBAR_KEY_LABEL.
# "history": print the daily record array from the last usage run.
# Diagnostics go to probe.log only, so stdout carries exactly one JSON value.

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

API="https://openrouter.ai/api/v1"
CACHE_DIR="$HOME/Library/Caches/claudebar-openrouter-key"
LOG_FILE="$CACHE_DIR/probe.log"
KEYS_FILE="$CACHE_DIR/keys.json"
ROWS_FILE="$CACHE_DIR/rows.json"
KEYS_TTL=55
KEYS_MAX_AGE=600
ACTIVITY_TTL=1800
KEYS_CURL_TIMEOUT=15
ACTIVITY_CURL_TIMEOUT=30
CREDITS_FILE="$CACHE_DIR/credits.json"
CREDITS_TTL=300
CREDITS_MAX_AGE=3600
CREDITS_CURL_TIMEOUT=15
ANALYTICS_TTL=300
ANALYTICS_CURL_TIMEOUT=15
LOG_MAX_BYTES=262144
HISTORY_WAIT=75

# Set by find_key_hash.
KEY_HASH=""
ACTIVITY_FILE=""
PARTIALS_FILE=""
ANALYTICS_FILE=""

# Appends "<UTC timestamp> <message>" to LOG_FILE, after rotate_log.
log() {
  rotate_log
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG_FILE"
}

# Empties LOG_FILE when it is larger than LOG_MAX_BYTES. Called by log.
rotate_log() {
  if [ "$(stat -f %z "$LOG_FILE" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    : > "$LOG_FILE"
  fi
}

# Returns 0 when cache file $1 is missing, empty, or at least $2 seconds old.
stale() {
  [ -s "$1" ] || return 0
  [ "$(( $(date +%s) - $(stat -f %m "$1") ))" -ge "$2" ]
}

# Downloads $1 with the management key into the cache file $2, through $2.tmp and mv -f.
# $3 is the curl --max-time. $4 is the payload kind that check_payload must accept.
# Returns 0 on success and 1 on failure, including a payload that fails check_payload. Curl stderr goes to LOG_FILE.
# The caller decides what a failure means.
fetch_json() {
  if ! printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/json"\n' "${CLAUDEBAR_MANAGEMENT_KEY}" \
    | curl -sS --fail --max-time "$3" -K - -o "$2.tmp" "$1" 2>>"$LOG_FILE"; then
    rm -f "$2.tmp"
    log "fetch failed: $1"
    return 1
  fi
  if ! check_payload "$2.tmp" "$4"; then
    rm -f "$2.tmp"
    log "invalid $4 payload: $1"
    return 1
  fi
  mv -f "$2.tmp" "$2"
}

# Returns 0 when FILE is a valid payload of KIND, else 1. KIND keys or activity needs a JSON object whose
# data is a list. KIND credits needs a JSON object whose data object has numeric total_credits and total_usage.
# Logs nothing. The caller logs.
check_payload() {
  python3 - "$1" "$2" 2>/dev/null <<'PY'
import json, sys
path, kind = sys.argv[1:3]
try:
    with open(path) as fh:
        payload = json.load(fh)
except (OSError, ValueError):
    sys.exit(1)
data = payload.get("data") if isinstance(payload, dict) else None
if kind in ("keys", "activity"):
    ok = isinstance(data, list)
elif kind == "credits":
    ok = isinstance(data, dict) and all(
        isinstance(data.get(key), (int, float)) and not isinstance(data.get(key), bool)
        for key in ("total_credits", "total_usage"))
else:
    ok = False
sys.exit(0 if ok else 1)
PY
}

# Exits 1 with a log line unless CLAUDEBAR_MANAGEMENT_KEY matches sk-or-????????????????*.
# The key value is never logged.
check_key() {
  case "${CLAUDEBAR_MANAGEMENT_KEY-}" in
    sk-or-????????????????*) ;;
    *)
      log "management key missing or malformed"
      exit 1
      ;;
  esac
}

# Makes KEYS_FILE current. Fetches /keys when KEYS_FILE is older than KEYS_TTL.
# If the fetch fails, a KEYS_FILE up to KEYS_MAX_AGE old is kept. Otherwise logs and exits 1.
fetch_keys() {
  if stale "$KEYS_FILE" "$KEYS_TTL" && ! fetch_json "$API/keys" "$KEYS_FILE" "$KEYS_CURL_TIMEOUT" keys; then
    if stale "$KEYS_FILE" "$KEYS_MAX_AGE"; then
      log "no key list newer than $KEYS_MAX_AGE s"
      exit 1
    fi
    log "using cached key list"
  fi
}

# Reads KEYS_FILE (python3 stdlib). Finds the entry whose label is CLAUDEBAR_KEY_LABEL.
# Sets KEY_HASH (full hash), ACTIVITY_FILE (activity-<first 12 chars>.json) and
# PARTIALS_FILE (partials-<first 12 chars>.json) and ANALYTICS_FILE (analytics-<first 12 chars>.json), all in CACHE_DIR.
# Logs "key <label> not found" and exits 1 when there is no such entry.
find_key_hash() {
  if ! KEY_HASH="$(python3 - "$KEYS_FILE" "$CLAUDEBAR_KEY_LABEL" 2>>"$LOG_FILE" <<'PY'
import json, sys
data = json.load(open(sys.argv[1])).get("data", [])
entry = next((e for e in data if isinstance(e, dict) and e.get("label") == sys.argv[2]), None)
print((entry or {}).get("hash") or "")
PY
)"; then
    log "key list unreadable"
    exit 1
  fi
  if [ -z "$KEY_HASH" ]; then
    log "key $CLAUDEBAR_KEY_LABEL not found"
    exit 1
  fi
  ACTIVITY_FILE="$CACHE_DIR/activity-$(printf '%s' "$KEY_HASH" | cut -c1-12).json"
  PARTIALS_FILE="$CACHE_DIR/partials-$(printf '%s' "$KEY_HASH" | cut -c1-12).json"
  ANALYTICS_FILE="$CACHE_DIR/analytics-$(printf '%s' "$KEY_HASH" | cut -c1-12).json"
}

# Refreshes ACTIVITY_FILE from /activity?api_key_hash=KEY_HASH when it is older than ACTIVITY_TTL.
# A failed fetch keeps the old file, logs the failure, and returns 0.
refresh_activity() {
  if stale "$ACTIVITY_FILE" "$ACTIVITY_TTL" && ! fetch_json "$API/activity?api_key_hash=$KEY_HASH" "$ACTIVITY_FILE" "$ACTIVITY_CURL_TIMEOUT" activity; then
    log "activity refresh failed, keeping previous file"
  fi
}

# Makes CREDITS_FILE current from /credits (account-wide, management key), when it is older than CREDITS_TTL.
# A failed fetch keeps the file while it is not stale CREDITS_MAX_AGE, else removes it. Failures only log. Never exits.
refresh_credits() {
  if stale "$CREDITS_FILE" "$CREDITS_TTL" && ! fetch_json "$API/credits" "$CREDITS_FILE" "$CREDITS_CURL_TIMEOUT" credits; then
    if stale "$CREDITS_FILE" "$CREDITS_MAX_AGE"; then
      rm -f "$CREDITS_FILE"
      log "no credits figure newer than $CREDITS_MAX_AGE s"
    else
      log "using cached credits"
    fi
  fi
}

# Makes ANALYTICS_FILE current from today's analytics (UTC midnight to now) when it is older than ANALYTICS_TTL.
# A failed fetch keeps the previous snapshot, logs the failure, and returns 0. Never exits.
refresh_analytics() {
  if stale "$ANALYTICS_FILE" "$ANALYTICS_TTL" && ! fetch_analytics; then
    log "analytics refresh failed, keeping previous snapshot"
  fi
}

# Downloads today's analytics for KEY_HASH from POST /analytics/query into ANALYTICS_FILE as {"date", "rows"}
# (python3 stdlib, via $ANALYTICS_FILE.tmp and mv -f). Returns 1 on a curl failure, an invalid payload, or a write
# failure, after logging. On an HTTP error, the first 200 bytes of the response body are logged. data.warnings are logged.
# Curl stderr goes to LOG_FILE.
fetch_analytics() {
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  today="${now%%T*}"
  body="$(printf '{"metrics":["total_usage","tokens_prompt","tokens_completion","cache_hit_rate"],"dimensions":["model"],"filters":[{"field":"api_key_id","operator":"eq","value":"%s"}],"time_range":{"start":"%sT00:00:00Z","end":"%s"},"limit":100}' "$KEY_HASH" "$today" "$now")"
  if ! printf 'header = "Authorization: Bearer %s"\nheader = "Accept: application/json"\nheader = "Content-Type: application/json"\n' "${CLAUDEBAR_MANAGEMENT_KEY}" \
    | curl -sS --fail-with-body --max-time "$ANALYTICS_CURL_TIMEOUT" -K - --data-binary "$body" -o "$ANALYTICS_FILE.raw" "$API/analytics/query" 2>>"$LOG_FILE"; then
    if [ -s "$ANALYTICS_FILE.raw" ]; then
      log "analytics error body: $(head -c 200 "$ANALYTICS_FILE.raw" | tr '\n' ' ')"
    fi
    rm -f "$ANALYTICS_FILE.raw"
    log "fetch failed: $API/analytics/query"
    return 1
  fi
  if ! warnings="$(python3 - "$today" "$ANALYTICS_FILE.raw" "$ANALYTICS_FILE.tmp" 2>>"$LOG_FILE" <<'PY'
import json, sys
day, raw_path, tmp_path = sys.argv[1:4]
with open(raw_path) as fh:
    payload = json.load(fh)
result = payload.get("data") if isinstance(payload, dict) else None
if not isinstance(result, dict) or not isinstance(result.get("data"), list):
    sys.exit(1)
if (result.get("metadata") or {}).get("truncated") is True:
    sys.exit(1)
rows = []
for row in result["data"]:
    if not isinstance(row, dict):
        continue
    prompt = float(row.get("tokens_prompt") or 0)
    rows.append({
        "model": row.get("model") or "unknown",
        "usage": float(row.get("total_usage") or 0),
        "prompt_tokens": round(prompt),
        "completion_tokens": round(float(row.get("tokens_completion") or 0)),
        "cached_tokens": round(prompt * float(row.get("cache_hit_rate") or 0)),
    })
with open(tmp_path, "w") as fh:
    json.dump({"date": day, "rows": rows}, fh)
warnings = result.get("warnings")
for warning in warnings if isinstance(warnings, list) else []:
    print(str(warning).replace("\n", " "))
PY
)"; then
    rm -f "$ANALYTICS_FILE.raw" "$ANALYTICS_FILE.tmp"
    log "invalid analytics payload: $API/analytics/query"
    return 1
  fi
  printf '%s\n' "$warnings" | while IFS= read -r warning; do
    [ -n "$warning" ] && log "analytics warning: $warning"
  done
  rm -f "$ANALYTICS_FILE.raw"
  mv -f "$ANALYTICS_FILE.tmp" "$ANALYTICS_FILE" || { log "analytics snapshot not written"; return 1; }
}

# Updates PARTIALS_FILE, a {utc_date: usage_daily} map (python3 stdlib).
# Sets today's UTC entry from the key's usage_daily (overwrite, never max) and drops dates older than today minus 3 days.
update_partials() {
  if ! python3 - "$KEYS_FILE" "$CLAUDEBAR_KEY_LABEL" "$PARTIALS_FILE" "$PARTIALS_FILE.tmp" 2>>"$LOG_FILE" <<'PY'
import datetime, json, sys
keys_path, label, partials_path, tmp_path = sys.argv[1:5]
data = json.load(open(keys_path)).get("data", [])
entry = next(e for e in data if isinstance(e, dict) and e.get("label") == label)
today = datetime.datetime.now(datetime.timezone.utc).date()
cutoff = today - datetime.timedelta(days=3)
try:
    with open(partials_path) as fh:
        stored = json.load(fh)
except (OSError, ValueError):
    stored = {}
if not isinstance(stored, dict):
    stored = {}
partials = {}
for day, usage in stored.items():
    try:
        when = datetime.date.fromisoformat(day)
        value = float(usage)
    except (TypeError, ValueError):
        continue
    if when >= cutoff:
        partials[day] = value
partials[today.isoformat()] = float(entry.get("usage_daily") or 0)
with open(tmp_path, "w") as fh:
    json.dump(partials, fh, sort_keys=True)
PY
  then
    log "partials update failed"
    exit 1
  fi
  mv -f "$PARTIALS_FILE.tmp" "$PARTIALS_FILE" || exit 1
}

# Writes ROWS_FILE atomically (tmp file, then mv -f) from ACTIVITY_FILE, PARTIALS_FILE and ANALYTICS_FILE (python3 stdlib).
# Callers only run it when ACTIVITY_FILE holds a valid payload.
# Activity rows are grouped by (date[:10], model), with model = model, then model_permaslug, then "unknown".
# Today's analytics rows are added as activity rows when the snapshot is for today and activity has no row for today.
# Partial rows are added for each partials date that has no activity or analytics row and usage > 0.
write_rows() {
  if ! python3 - "$ACTIVITY_FILE" "$PARTIALS_FILE" "$ANALYTICS_FILE" "$ROWS_FILE.tmp" 2>>"$LOG_FILE" <<'PY'
import datetime, json, sys
activity_path, partials_path, analytics_path, tmp_path = sys.argv[1:5]
with open(activity_path) as fh:
    activity = json.load(fh)["data"]
with open(partials_path) as fh:
    partials = json.load(fh)
groups = {}
for row in activity:
    if not isinstance(row, dict) or not row.get("date"):
        continue
    date = str(row["date"])[:10]
    model = row.get("model") or row.get("model_permaslug") or "unknown"
    total = groups.setdefault((date, model), {"usage": 0.0, "prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0})
    total["usage"] += float(row.get("usage") or 0)
    for field in ("prompt_tokens", "completion_tokens", "cached_tokens"):
        total[field] += int(float(row.get(field) or 0))
rows = [{"kind": "activity", "date": date, "model": model, **total} for (date, model), total in sorted(groups.items())]
active_dates = {date for date, _ in groups}
today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
try:
    with open(analytics_path) as fh:
        snapshot = json.load(fh)
except (OSError, ValueError):
    snapshot = {}
analytics_rows = snapshot.get("rows") if isinstance(snapshot, dict) and snapshot.get("date") == today else None
if isinstance(analytics_rows, list) and analytics_rows and today not in active_dates:
    rows.extend({"kind": "activity", "date": today, **row} for row in analytics_rows if isinstance(row, dict))
    active_dates.add(today)
for day in sorted(partials):
    usage = float(partials[day])
    if day not in active_dates and usage > 0:
        rows.append({"kind": "partial", "date": day, "usage": usage})
with open(tmp_path, "w") as fh:
    json.dump(rows, fh)
PY
  then
    log "rows file not written"
    exit 1
  fi
  mv -f "$ROWS_FILE.tmp" "$ROWS_FILE" || exit 1
}

# Prints {"caps": [...], "credits_remaining": n} for the tracked key, from KEYS_FILE, with one printf.
# "today" is no longer printed, because the API COST card is removed. credits_remaining is omitted unless CREDITS_FILE is not stale CREDITS_MAX_AGE.
# Caps are [] when limit is null. Otherwise name and resets_at follow limit_reset (daily, weekly, monthly;
# anything else gives "Limit" with no resets_at). window_seconds is set only for daily and weekly, so ClaudeBar
# shows no pace or forecast for Monthly or Limit.
print_usage() {
  credits_path=""
  if ! stale "$CREDITS_FILE" "$CREDITS_MAX_AGE"; then
    credits_path="$CREDITS_FILE"
  fi
  if ! OUTPUT="$(python3 - "$KEYS_FILE" "$CLAUDEBAR_KEY_LABEL" "$credits_path" 2>>"$LOG_FILE" <<'PY'
import calendar, datetime, json, sys
data = json.load(open(sys.argv[1])).get("data", [])
entry = next((e for e in data if isinstance(e, dict) and e.get("label") == sys.argv[2]), None)
if entry is None:
    sys.exit("key not found")
today = datetime.datetime.now(datetime.timezone.utc).date()
midnight = datetime.datetime.combine(today, datetime.time(), tzinfo=datetime.timezone.utc)
caps = []
limit = entry.get("limit")
if limit is not None:
    limit = float(limit)
    reset = entry.get("limit_reset")
    window_fields = {"daily": "usage_daily", "weekly": "usage_weekly", "monthly": "usage_monthly"}
    if entry.get("limit_remaining") is None:
        spent = float(entry.get(window_fields.get(reset, "usage")) or 0)
    else:
        spent = limit - float(entry["limit_remaining"])
    spent = max(0.0, spent)
    if reset == "daily":
        name, resets_at, window = "Daily", midnight + datetime.timedelta(days=1), 86400
    elif reset == "weekly":
        name, resets_at, window = "Weekly", midnight + datetime.timedelta(days=7 - today.weekday()), 604800
    elif reset == "monthly":
        days = calendar.monthrange(today.year, today.month)[1]
        first_of_next = today.replace(day=1) + datetime.timedelta(days=days)
        name = "Monthly"
        resets_at = datetime.datetime.combine(first_of_next, datetime.time(), tzinfo=datetime.timezone.utc)
        window = None
    else:
        name, resets_at, window = "Limit", None, None
    cap = {"name": name, "remaining": max(0.0, limit - spent), "limit": limit}
    if resets_at is not None:
        cap["resets_at"] = resets_at.strftime("%Y-%m-%dT%H:%M:%SZ")
        if window is not None:
            cap["window_seconds"] = window
    caps.append(cap)
output = {"caps": caps}
if len(sys.argv) > 3 and sys.argv[3]:
    try:
        with open(sys.argv[3]) as fh:
            credits = json.load(fh)["data"]
        output["credits_remaining"] = float(credits["total_credits"]) - float(credits["total_usage"])
    except (OSError, ValueError, KeyError, TypeError):
        pass
print(json.dumps(output))
PY
)"; then
    log "usage output failed"
    exit 1
  fi
  printf '%s\n' "$OUTPUT"
}

# Usage mode, in order: check_key, fetch_keys, find_key_hash, refresh_activity, refresh_credits, refresh_analytics,
# update_partials, write_rows (only with a valid activity file), print_usage. Any failure exits 1, except refresh_credits and refresh_analytics, which only log.
run_usage() {
  check_key
  fetch_keys
  find_key_hash
  refresh_activity
  refresh_credits
  refresh_analytics
  update_partials
  if [ -s "$ACTIVITY_FILE" ]; then
    write_rows
  else
    log "no activity data yet, rows file kept"
  fi
  print_usage
}

# Waits up to HISTORY_WAIT seconds, checking once a second, for ROWS_FILE to exist.
# Returns as soon as it exists, or when the time is up.
wait_for_rows() {
  waited=0
  while [ ! -f "$ROWS_FILE" ] && [ "$waited" -lt "$HISTORY_WAIT" ]; do
    sleep 1
    waited=$((waited + 1))
  done
}

# Prints ROWS_FILE unchanged. When it is missing, logs and exits 1. Needs no secret.
print_history() {
  if [ -f "$ROWS_FILE" ]; then
    cat "$ROWS_FILE"
  else
    log "rows file missing: $ROWS_FILE"
    exit 1
  fi
}

mkdir -p "$CACHE_DIR"
case "${1-}" in
  "") run_usage ;;
  history)
    wait_for_rows
    print_history
    ;;
  *)
    echo "usage: probe.sh [history]" >&2
    exit 1
    ;;
esac
