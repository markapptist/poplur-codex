#!/bin/bash
# Is that pid still the process that wrote this lock?
#
# `kill -0 $pid` answers "does a process with this number exist" — which, on a
# machine that has been up for days, is a different question from "is my owner
# still running". Pids get recycled, and when one is, a lock pins its resource
# forever with no error anywhere.
#
# Observed 2026-09-06: build product ios-iphone-20260904-080014 was skipped by
# every prune as "build-lock pid 1092 alive". Pid 1092 was `translationd`, a
# macOS system daemon that had inherited the number from a build two days
# earlier. 4 GB unreclaimable, and nothing said so — the prune reported the
# directory as legitimately in use. The same weakness was in the device lock in
# lib/device-install.sh, where a recycled pid makes a dead session's lock look
# alive and every later install waits out the full timeout for a process that
# is not there.
#
# The fix is to record WHICH process, not just its number: a pid's start time
# is fixed for its lifetime and a recycled pid necessarily has a later one.
#
#   pid_start_token PID    an identity token for PID (its start time); empty if gone
#   pid_is_owner PID TOKEN  true when PID exists AND is the process TOKEN came from
#
# An EMPTY token means a lock written before this existed. Those fall back to
# bare liveness — the old behaviour, bug included — because the alternative is
# to treat every pre-existing lock as stale the moment this ships, which would
# break live builds to fix a slow leak. They age out on their own.

pid_start_token() {
  [ -n "${1:-}" ] || return 0
  case "$1" in *[!0-9]*) return 0 ;; esac
  # lstart is an absolute wall-clock start time, stable for the process's life.
  # Whitespace is squeezed because ps pads the day-of-month.
  ps -p "$1" -o lstart= 2>/dev/null | tr -s ' ' | sed 's/^ *//; s/ *$//'
}

pid_is_owner() {
  local pid="${1:-}" token="${2:-}" current
  [ -n "$pid" ] || return 1
  case "$pid" in *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ -n "$token" ] || return 0
  current="$(pid_start_token "$pid")"
  [ -n "$current" ] && [ "$current" = "$token" ]
}
