#!/bin/sh
# Checks a running derived-image container from inside (design 5.9, docs/DEPLOY.md). It is piped in, never copied
# into the image:
#
#   docker exec -i <container> sh -s < scripts/image-checks.sh
#
# The container runs the image's own entrypoint with throwaway configuration (docs/CI.md has the commands). Every
# check runs, each failure names what was missing, and the script exits 1 if any failed. POSIX sh: `sh -s` runs it
# under the image's dash.
set -u

failures=0
pass() { printf 'image-checks: ok: %s\n' "$1"; }
fail() {
  printf 'image-checks: FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}

# 1. setpriv, which Remotion wraps Chrome in for its pdeathsig, and which the service's startup check requires.
if command -v setpriv >/dev/null 2>&1; then
  pass "setpriv is on PATH at $(command -v setpriv)"
else
  fail "setpriv is missing from PATH ($PATH)"
fi

# 2. No npm in the runtime: the service never installs anything and never falls back to npx.
if command -v npm >/dev/null 2>&1; then
  fail "npm is present in the runtime image at $(command -v npm)"
else
  pass "npm is absent"
fi
if command -v npx >/dev/null 2>&1; then
  fail "npx is present in the runtime image at $(command -v npx)"
else
  pass "npx is absent"
fi

# 3. tini is PID 1, so orphans are reaped and SIGTERM reaches the service.
pid1=$(tr '\000' ' ' < /proc/1/cmdline 2>/dev/null)
case "$pid1" in
  *tini*) pass "PID 1 is tini ($pid1)" ;;
  *) fail "PID 1 is not tini: its cmdline is '$pid1'" ;;
esac

# 4 and 5. The pinned browser runs, and none of its shared libraries is missing.
if [ -z "${BROWSER_EXECUTABLE:-}" ]; then
  fail "BROWSER_EXECUTABLE is not set in the container's environment"
else
  if version=$("$BROWSER_EXECUTABLE" --version 2>&1); then
    pass "the browser runs: $version"
  else
    fail "the browser at $BROWSER_EXECUTABLE did not run --version: $version"
  fi
  if libs=$(ldd "$BROWSER_EXECUTABLE" 2>&1); then
    missing=$(printf '%s\n' "$libs" | grep 'not found')
    if [ -n "$missing" ]; then
      fail "the browser's shared libraries are missing: $(printf '%s' "$missing" | tr '\n' ';')"
    else
      pass "ldd finds every shared library of the browser"
    fi
  else
    fail "ldd could not read $BROWSER_EXECUTABLE: $libs"
  fi
fi

# 6. The @remotion/renderer the pack's CLI loads is at least 4.0.458, resolved from the CLI's own package.json as the
# service's startup check resolves it. Numeric parts: a string comparison would put 4.0.99 above 4.0.458.
if renderer=$(node -e '
  const path = require("node:path");
  const { createRequire } = require("node:module");
  const cli = path.resolve(process.env.PACK_DIR || "/pack", "node_modules/@remotion/cli/package.json");
  let version;
  try {
    version = require(createRequire(cli).resolve("@remotion/renderer/package.json")).version;
  } catch {
    console.log("is missing: none resolves from " + cli);
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) {
    console.log(String(version) + " is not a plain x.y.z release");
    process.exit(1);
  }
  const have = String(version).split(".").map(Number);
  const min = [4, 0, 458];
  const below = (have[0] - min[0] || have[1] - min[1] || have[2] - min[2]) < 0;
  console.log(version + (below ? " is below 4.0.458" : " is at least 4.0.458"));
  process.exit(below ? 1 : 0);
' 2>&1); then
  pass "@remotion/renderer $renderer"
else
  fail "@remotion/renderer $renderer"
fi

# 7. The audit log's directory is writable by the user the service runs as, proved by a write.
dir=/var/log/remotion-viz
probe="$dir/.image-checks.$$"
if [ -d "$dir" ] && [ -w "$dir" ] && : > "$probe" 2>/dev/null; then
  rm -f "$probe"
  pass "$dir is writable by $(id -un 2>/dev/null || id -u)"
else
  fail "$dir is missing or not writable by $(id -un 2>/dev/null || id -u)"
fi

if [ "$failures" -gt 0 ]; then
  printf 'image-checks: %s check(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'image-checks: all checks passed\n'
