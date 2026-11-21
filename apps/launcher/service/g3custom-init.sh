#!/bin/sh
# G3 Custom – makes the launcher the TV's home screen and gives its service root.
#
# Installed as /var/lib/webosbrew/init.d/90-g3custom and run by the Homebrew Channel
# at every boot. (No dot in the file name: run-parts skips such files.)
#
#   90-g3custom           boot: start the watcher in the background and start the launcher
#   90-g3custom start     start the watcher without starting the launcher
#   90-g3custom elevate   give the launcher's service root now
#   90-g3custom stop      stop the watcher
#   90-g3custom status    print the state
#   90-g3custom screen [off|on|toggle]   turn the screen off/on (sound keeps playing); without an argument: toggle
#   90-g3custom lghome    show LG's own home screen (until another app is opened)
#
# The watcher:
#   - elevates the launcher's service to root (the Homebrew Channel's elevate-service) and does it again
#     within 20 s after the app is reinstalled
#   - starts the launcher when the TV is switched on and when it wakes from standby
#   - takes over the Home button: when LG's home screen comes to the foreground the launcher is started instead
#     (except when it was opened on purpose via the "LG webOS" tile)
#   - starts LG Input Hook (if present) – it does not start by itself after the TV restarts
#   - keeps the launcher started in the background ("preload"), so that the Home button finds it warm even
#     after a reinstall or if the TV has closed it
#
# Keep root but do not start the launcher automatically:  touch /var/luna/preferences/g3custom_nolaunch
# Let the Home button open LG's home screen again:         touch /var/luna/preferences/g3custom_nohome
# Remove completely:  sh /var/lib/webosbrew/init.d/90-g3custom stop; rm /var/lib/webosbrew/init.d/90-g3custom

APP=com.g3custom.launcher
SVC=com.g3custom.launcher.service
HB=${G3_HB:-/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service}
SVCFILE=${G3_SVCFILE:-/var/luna-service2-dev/services.d/$SVC.service}
PIDFILE=${G3_PIDFILE:-/tmp/g3custom.pid}
NOLAUNCH=${G3_NOLAUNCH:-/var/luna/preferences/g3custom_nolaunch}
NOHOME=${G3_NOHOME:-/var/luna/preferences/g3custom_nohome}
HWFIFO=${G3_HWFIFO:-/tmp/g3custom-home.fifo}
LGHOME=${G3_LGHOME:-/tmp/g3custom-lghome}
SCREENTS=${G3_SCREENTS:-/tmp/g3custom-screen.ts}
IHMARK=${G3_IHMARK:-/tmp/inputhook}
LOG=${G3_LOG:-/tmp/g3custom.log}
FIFO=${G3_FIFO:-/tmp/g3custom.fifo}
LUNA=${G3_LUNA_SEND:-luna-send}
GUARD_S=${G3_GUARD_S:-20}
PRELOAD_EVERY=${G3_PRELOAD_EVERY:-15}
SELF=$0

export PATH="/bin:/sbin:/usr/bin:/usr/sbin:$PATH"

log() {
  # Keep the log short (it lives in /tmp).
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 65536 ]; then mv -f "$LOG" "$LOG.old"; fi
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

# luna-send must have stdin from /dev/null, otherwise no response arrives in some environments.
luna() { "$LUNA" -n 1 -w 5000 "$1" "$2" </dev/null 2>/dev/null; }

installed() { [ -f "$SVCFILE" ]; }
elevated() { grep -q 'hbchannel.service/run-js-service' "$SVCFILE" 2>/dev/null; }

elevate() {
  installed || return 1
  elevated && return 0
  if [ ! -x "$HB/elevate-service" ]; then
    log "can't find $HB/elevate-service (Homebrew Channel)"
    return 1
  fi
  log "elevating $SVC to root"
  "$HB/elevate-service" "$SVC" </dev/null >>"$LOG" 2>&1
  # Stop the old, non-elevated service process; the next call starts it as root.
  # ([c] stops the pattern from matching pgrep itself.) Node processes only: otherwise the pattern
  # also matches a luna-send call to the service or an SSH script that mentions it.
  for p in $(pgrep -f '[c]om\.g3custom\.launcher\.service' 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    case "$(readlink "/proc/$p/exe" 2>/dev/null)" in
      */node*) kill "$p" 2>/dev/null ;;
    esac
  done
  elevated
}

# keepAlive: ask the app launcher (SAM) not to close the launcher when memory gets tight, so that
# the Home button finds it warm instead of restarting it from scratch.
launch() { luna luna://com.webos.applicationManager/launch "{\"id\":\"$APP\",\"keepAlive\":true}"; }

# The launcher in the background: started but not in front. The app manager has its own mode for that
# ("preload": the app is started in the background and what is on screen is left alone). Only done when the app manager
# has replied that the launcher is not running, and not when autostart is turned off.
preload() {
  [ -f "$NOLAUNCH" ] && return 0
  r=$(luna luna://com.webos.applicationManager/running '{}')
  case "$r" in *'"returnValue": true'*|*'"returnValue":true'*) ;; *) return 0 ;; esac
  case "$r" in *"\"$APP\""*) return 0 ;; esac
  luna luna://com.webos.applicationManager/launch "{\"id\":\"$APP\",\"preload\":\"full\",\"keepAlive\":true}" >/dev/null
  log "launcher started in the background"
}

# LG Input Hook (catches the Home button before LG's home screen has time to appear) also needs root. Its app
# cannot ask the Homebrew Channel for it by itself on this firmware, and an update removes the elevation.
IH=org.webosbrew.inputhook.service
IHFILE=${G3_IHFILE:-/var/luna-service2-dev/services.d/$IH.service}
ih_elevate() {
  [ -f "$IHFILE" ] || return 0
  grep -q 'hbchannel.service/run-js-service' "$IHFILE" && return 0
  [ -x "$HB/elevate-service" ] || return 1
  log "elevating $IH to root"
  "$HB/elevate-service" "$IH" </dev/null >>"$LOG" 2>&1
  # Only the Node service (the process name starts with the service's name) – not the hooks it has started.
  for p in $(pgrep -f '^org\.webosbrew\.inputhook\.service' 2>/dev/null); do kill "$p" 2>/dev/null; done
  luna "luna://$IH/start" '{}' >/dev/null
}

# LG Input Hook does not start by itself after the TV restarts (its own autostart only exists if it
# has been turned on in its app). Without it the Home button takes the detour via LG's home screen, and the shortcut button
# for Screen off does not work. The service creates /tmp/inputhook when the hook is in place.
IH_TRIES=0
ih_start() {
  [ -f "$IHFILE" ] || return 0
  [ -f "$IHMARK" ] && return 0
  grep -q 'hbchannel.service/run-js-service' "$IHFILE" || return 0
  [ "$IH_TRIES" -ge 15 ] && return 0
  IH_TRIES=$((IH_TRIES + 1))
  if luna "luna://$IH/start" '{}' | grep -q '"returnValue": *true'; then
    log "started $IH"
  fi
}

# Screen off: the picture goes dark, the sound keeps playing (the same call LG's media player makes for music).
# Used by the shortcut button (LG Input Hook runs "90-g3custom screen toggle") – in any app.
# A button that is held down sends several presses: at most one toggle per two seconds.
TVPOWER=luna://com.webos.service.tvpower/power
screen() {
  case "$1" in
    on) luna "$TVPOWER/turnOnScreen" '{}' >/dev/null ;;
    off) luna "$TVPOWER/turnOffScreen" '{}' >/dev/null ;;
    *)
      now=$(date +%s)
      last=$(cat "$SCREENTS" 2>/dev/null)
      [ -n "$last" ] && [ $((now - last)) -lt 2 ] && return 0
      echo "$now" > "$SCREENTS"
      st=$(luna "$TVPOWER/getPowerState" '{}' | sed -n 's/.*"state": *"\([^"]*\)".*/\1/p')
      if [ "$st" = "Screen Off" ]; then screen on; else screen off; fi
      ;;
  esac
}

# LG's own home screen, opened on purpose: the flag stops the watcher from switching back.
lghome() {
  date +%s > "$LGHOME"
  luna luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}' >/dev/null
}

foreground() {
  luna luna://com.webos.applicationManager/getForegroundAppInfo '{}' |
    sed -n 's/.*"appId": *"\([^"]*\)".*/\1/p'
}

# The TV often starts Live TV or LG's home shortly after us – take the screen back once.
reclaim() {
  sleep 6
  case "$(foreground)" in
    ""|com.webos.app.livetv|com.webos.app.home|com.webos.app.homeconnect) launch >/dev/null ;;
  esac
}

# Boot: wait until the app manager accepts calls (max ~2 min) and start the launcher.
boot() {
  [ -f "$NOLAUNCH" ] && return 0
  i=0
  while [ $i -lt 60 ]; do
    launch | grep -q '"returnValue": *true' && break
    i=$((i + 1))
    sleep 2
  done
  log "launcher started at boot"
  reclaim
}

# Standby -> on: start the launcher again (not when only the screen is turned off and on).
# The subscription is read via a FIFO so that the luna-send process can be stopped.
power() {
  while :; do
    rm -f "$FIFO"
    mkfifo "$FIFO" 2>/dev/null || { sleep 30; continue; }
    "$LUNA" -i luna://com.webos.service.tvpower/power/getPowerState '{"subscribe":true}' </dev/null >"$FIFO" 2>/dev/null &
    echo $! > "$PIDFILE.ls"
    prev=""
    while read -r line; do
      state=$(echo "$line" | sed -n 's/.*"state": *"\([^"]*\)".*/\1/p')
      [ -z "$state" ] && continue
      if [ "$state" = "Active" ] && [ -n "$prev" ] && [ "$prev" != "Active" ] &&
        [ "$prev" != "Screen Off" ] && [ "$prev" != "Screen Saver" ] && [ ! -f "$NOLAUNCH" ]; then
        log "woke up ($prev -> Active)"
        sleep 1
        launch >/dev/null
        reclaim &
      fi
      prev="$state"
    done < "$FIFO"
    kill "$(cat "$PIDFILE.ls" 2>/dev/null)" 2>/dev/null
    sleep 5
  done
}

# The Home button: LG's home screen (com.webos.app.home) is opened by the Home button, by Back from the last
# app and when nothing else is in front. Switch straight to the launcher.
homewatch() {
  while :; do
    rm -f "$HWFIFO"
    mkfifo "$HWFIFO" 2>/dev/null || { sleep 30; continue; }
    "$LUNA" -i luna://com.webos.applicationManager/getForegroundAppInfo '{"subscribe":true}' </dev/null >"$HWFIFO" 2>/dev/null &
    echo $! > "$PIDFILE.hwls"
    while read -r line; do
      case "$line" in
        *'"appId": "com.webos.app.home"'*|*'"appId":"com.webos.app.home"'*)
          # Opened on purpose (the "LG webOS" tile)? Leave it alone.
          if [ ! -f "$LGHOME" ] && [ ! -f "$NOHOME" ]; then
            launch >/dev/null
          fi
          ;;
        *'"appId": ""'*|*'"appId":""'*) ;;
        *'"appId"'*)
          # Another app is in front: the next time LG's home screen appears it is taken over as usual.
          [ -f "$LGHOME" ] && rm -f "$LGHOME"
          ;;
      esac
    done < "$HWFIFO"
    kill "$(cat "$PIDFILE.hwls" 2>/dev/null)" 2>/dev/null
    sleep 5
  done
}

# After a reinstall the TV rewrites the service's files – elevate it again.
guard() {
  # First check of the launcher already after one round (the watcher may have been restarted after a reinstall).
  n=$((PRELOAD_EVERY - 1))
  while :; do
    sleep "$GUARD_S"
    n=$((n + 1))
    # After a reinstall the TV has closed the launcher: start it in the background again straight away.
    if installed && ! elevated; then elevate && n=0; fi
    ih_elevate
    ih_start
    # Otherwise a check now and then (every five minutes with the default values).
    if [ $((n % PRELOAD_EVERY)) -eq 0 ]; then preload; fi
  done
}

cleanup() {
  kill $(cat "$PIDFILE.guard" "$PIDFILE.ls" "$PIDFILE.hw" "$PIDFILE.hwls" 2>/dev/null) 2>/dev/null
  rm -f "$PIDFILE" "$PIDFILE.guard" "$PIDFILE.ls" "$PIDFILE.hw" "$PIDFILE.hwls" "$FIFO" "$HWFIFO"
}

# Close connections inherited from whoever started the watcher. If it is started by the launcher's service
# (the service does that when the script has been updated) it otherwise inherits the service's connection to the Luna bus.
# The bus then thinks the service is still alive after it has exited or been replaced, starts no new one,
# and all calls to the service go unanswered until the TV is restarted. (Discovered 2026-11-21.)
# Only sockets, pipes and anon_inode are closed – the shell reads the script itself via its own file (fd 10).
close_inherited() {
  for f in /proc/$$/fd/*; do
    n=${f##*/}
    case "$n" in 0|1|2|*[!0-9]*) continue ;; esac
    case "$(readlink "$f" 2>/dev/null)" in
      socket:*|pipe:*|anon_inode:*) eval "exec $n>&-" 2>/dev/null ;;
    esac
  done
}

watch() {
  close_inherited
  echo $$ > "$PIDFILE"
  trap 'cleanup; exit 0' TERM INT
  log "watcher starting (pid $$)"
  elevate
  ih_elevate
  ih_start
  guard &
  echo $! > "$PIDFILE.guard"
  homewatch &
  echo $! > "$PIDFILE.hw"
  [ "$1" = "boot" ] && boot
  power
}

running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; }

spawn() {
  if command -v setsid >/dev/null 2>&1; then
    setsid sh "$SELF" watch "$1" </dev/null >/dev/null 2>&1 &
  else
    sh "$SELF" watch "$1" </dev/null >/dev/null 2>&1 &
  fi
}

case "$1" in
  watch)
    watch "$2"
    ;;
  start)
    running || spawn nolaunch
    ;;
  elevate)
    if elevate; then echo "elevated"; else echo "not elevated"; exit 1; fi
    ;;
  stop)
    if running; then
      kill "$(cat "$PIDFILE")" 2>/dev/null
    fi
    cleanup
    ;;
  status)
    installed && echo "installed" || echo "app not installed"
    elevated && echo "elevated" || echo "not elevated"
    running && echo "running" || echo "stopped"
    [ -f "$NOLAUNCH" ] && echo "launch off" || echo "launch on"
    [ -f "$NOHOME" ] && echo "home button off" || echo "home button on"
    if [ -f "$IHFILE" ]; then [ -f "$IHMARK" ] && echo "input hook on" || echo "input hook off"; fi
    ;;
  screen)
    screen "$2"
    ;;
  lghome)
    lghome
    ;;
  *)
    # Boot (run-parts): do not block, run the watcher detached.
    running || spawn boot
    ;;
esac
exit 0
