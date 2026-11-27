#!/bin/sh
# The macOS script utility gives the official interactive CLI its own PTY session.
# No transcript is recorded and the CLI is never sent a prompt.
umask 077

if [ "$1" = "--inside-pty" ]; then
  shift
  # This shell remains the PTY process-group leader even if agy exits first.
  printf '%s\n' "$$" > "$GRAVITY_QUOTA_CONTROL/leader" || exit 1
  group=$$
  # If the supervisor is killed outright, its EXIT trap cannot release this separate PTY group.
  (
    trap '' HUP
    while kill -0 "$GRAVITY_QUOTA_SUPERVISOR" 2>/dev/null; do /bin/sleep 0.2; done
    trap '' TERM
    # SIGKILL bypasses the supervisor's EXIT trap, even during the start handshake.
    # Terminate the PTY process group before cleaning this mktemp control directory.
    kill -s TERM -- "-$group" 2>/dev/null || :
    /bin/sleep 0.5
    kill -s KILL -- "-$group" 2>/dev/null || :
    case "$GRAVITY_QUOTA_CONTROL" in
      "$GRAVITY_QUOTA_CWD"/pty.????????)
        for name in feed recorder leader start finished reading.json; do
          /bin/rm -f "$GRAVITY_QUOTA_CONTROL/$name"
        done
        /bin/rm -f "$GRAVITY_QUOTA_CONTROL"/reading.json.*.tmp 2>/dev/null || :
        /bin/rmdir "$GRAVITY_QUOTA_CONTROL" 2>/dev/null || :
        ;;
    esac
  ) </dev/null >/dev/null 2>&1 &
  while [ ! -f "$GRAVITY_QUOTA_CONTROL/start" ]; do
    kill -0 "$GRAVITY_QUOTA_SUPERVISOR" 2>/dev/null || exit 1
    /bin/sleep 0.1
  done
  /bin/stty rows 35 columns 120 || exit 1
  "$@"
  printf '%s\n' "$?" > "$GRAVITY_QUOTA_CONTROL/finished"
  while kill -0 "$GRAVITY_QUOTA_SUPERVISOR" 2>/dev/null; do /bin/sleep 0.1; done
  exit 0
fi

[ -x /usr/bin/script ] && [ -x /usr/bin/osascript ] && [ -r "$GRAVITY_QUOTA_CALLBACK" ] || exit 3
[ -f "$1" ] && [ -x "$1" ] || exit 4
host=$PPID
GRAVITY_QUOTA_SUPERVISOR=$$
GRAVITY_QUOTA_CONTROL=$(/usr/bin/mktemp -d "$GRAVITY_QUOTA_CWD/pty.XXXXXXXX") || exit 5
result=$GRAVITY_QUOTA_RESULT
GRAVITY_QUOTA_RESULT=$GRAVITY_QUOTA_CONTROL/reading.json
export GRAVITY_QUOTA_CONTROL GRAVITY_QUOTA_SUPERVISOR GRAVITY_QUOTA_RESULT
leader=''
recorder=''
cleanup() {
  trap '' HUP INT TERM
  if [ -z "$leader" ] && [ -s "$GRAVITY_QUOTA_CONTROL/leader" ]; then
    IFS= read -r marker < "$GRAVITY_QUOTA_CONTROL/leader" || marker=''
    case "$marker" in ''|*[!0-9]*) ;; *) [ "$marker" -gt 1 ] && leader=$marker ;; esac
  fi
  if [ -n "$leader" ]; then
    kill -s TERM -- "-$leader" 2>/dev/null || :
    count=5
    while [ "$count" -gt 0 ] && kill -s 0 -- "-$leader" 2>/dev/null; do
      /bin/sleep 0.1
      count=$((count - 1))
    done
    kill -s KILL -- "-$leader" 2>/dev/null || :
  fi
  /bin/rm -f "$GRAVITY_QUOTA_CONTROL/feed"
  if [ -s "$GRAVITY_QUOTA_CONTROL/recorder" ]; then
    IFS= read -r spid < "$GRAVITY_QUOTA_CONTROL/recorder" || spid=''
    case "$spid" in ''|*[!0-9]*) ;; *) kill -KILL "$spid" 2>/dev/null || : ;; esac
  fi
  if [ -n "$recorder" ]; then
    kill -KILL "$recorder" 2>/dev/null || :
    wait "$recorder" 2>/dev/null || :
  fi
  # Each attempt owns only this mktemp directory; the result belongs to the caller.
  /bin/rm -rf "$GRAVITY_QUOTA_CONTROL"
}
trap cleanup 0
trap 'exit 5' HUP INT TERM

# Feed /usr/bin/script with a real kernel pipe(2) via shell pipeline '|':
# macOS FIFOs and libuv socketpairs both fail script's tcgetattr() with EOPNOTSUPP, whereas pipe(2) returns ENOTTY.
: > "$GRAVITY_QUOTA_CONTROL/feed" || exit 5
( while [ -f "$GRAVITY_QUOTA_CONTROL/feed" ] && kill -0 "$GRAVITY_QUOTA_SUPERVISOR" 2>/dev/null; do /bin/sleep 0.1; done ) </dev/null | (
  exec 3<&0
  /usr/bin/script -q -- /dev/null /bin/sh "$0" --inside-pty "$@" <&3 3<&- >/dev/null 2>&1 &
  spid=$!
  exec 3<&-
  printf '%s\n' "$spid" > "$GRAVITY_QUOTA_CONTROL/recorder"
  wait "$spid"
  /bin/rm -f "$GRAVITY_QUOTA_CONTROL/feed"
) >/dev/null 2>&1 &
recorder=$!
remaining=$((GRAVITY_QUOTA_WAIT * 10))
while :; do
  kill -0 "$host" 2>/dev/null || exit 5
  if [ -z "$leader" ] && [ -s "$GRAVITY_QUOTA_CONTROL/leader" ]; then
    IFS= read -r pid < "$GRAVITY_QUOTA_CONTROL/leader" || exit 5
    case "$pid" in ''|*[!0-9]*) exit 5 ;; esac
    [ "$pid" -gt 1 ] && kill -s 0 -- "-$pid" 2>/dev/null || exit 5
    leader=$pid
    : > "$GRAVITY_QUOTA_CONTROL/start" || exit 5
  fi
  if [ -s "$GRAVITY_QUOTA_RESULT" ]; then
    /bin/mv "$GRAVITY_QUOTA_RESULT" "$result" || exit 5
    exit 0
  fi
  if [ -s "$GRAVITY_QUOTA_CONTROL/finished" ]; then
    if [ -s "$GRAVITY_QUOTA_RESULT" ]; then continue; fi
    IFS= read -r code < "$GRAVITY_QUOTA_CONTROL/finished" || exit 5
    case "$code" in 126|127) exit 4 ;; *) exit 1 ;; esac
  fi
  kill -0 "$recorder" 2>/dev/null || exit 5
  [ "$remaining" -gt 0 ] || exit 2
  /bin/sleep 0.1
  remaining=$((remaining - 1))
done
