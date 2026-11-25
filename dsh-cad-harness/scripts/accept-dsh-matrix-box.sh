#!/bin/sh
# Runs one DSH version against this plugin checkout.
#
# Used in two places:
#   - inside a kern box (host orchestrator mounts the repo at /work), and
#   - on the host for `--engine local` (same script, no container).
#
# Usage:
#   accept-dsh-matrix-box.sh <version> <result-file> <dsh-prefix> <plugin-root> [log-dir]
#
# <dsh-prefix> holds node_modules/@deepseek-ai/dsh (the version being tested).
# Output is line-oriented so the host can parse it without JSON escaping:
#   CHECK <name>=pass|fail <detail...>
# The script never needs the network: the mock model listens on loopback.

set -u

VERSION=${1:?usage: accept-dsh-matrix-box.sh <version> <result> <dsh-prefix> <plugin-root> [log-dir]}
RESULT=${2:?missing result file}
DSH_PREFIX=${3:?missing dsh prefix}
PLUGIN_ROOT=${4:?missing plugin root}
LOG_DIR=${5:-$(dirname "$RESULT")}

DSH_BIN="$DSH_PREFIX/node_modules/@deepseek-ai/dsh/lib/bin.js"
CONFIG="$PLUGIN_ROOT/dsh-matrix.json"
MOCK="$PLUGIN_ROOT/scripts/accept-dsh-matrix-mock.mjs"
PORT_BASE=${DSH_MATRIX_PORT_BASE:-4331}

mkdir -p "$LOG_DIR"
: > "$RESULT"

FAILED=0
check() {
  name=$1
  status=$2
  shift 2
  printf 'CHECK %s=%s %s\n' "$name" "$status" "$*" >> "$RESULT"
  printf '  %-10s %-4s %s\n' "$name" "$status" "$*"
  [ "$status" = pass ] || FAILED=1
}

HOST_HOME=$(mktemp -d "${TMPDIR:-/tmp}/dsh-matrix-XXXXXX")
DSH_HOME="$HOST_HOME/home"
PROFILE="$DSH_HOME/profiles/matrix"
MOCK_PID=
cleanup() {
  if [ -n "$MOCK_PID" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
  fi
  if [ "${DSH_MATRIX_KEEP_HOME:-0}" = 1 ]; then
    echo "kept DSH_HOME at $DSH_HOME"
  else
    rm -rf "$HOST_HOME"
  fi
}
trap cleanup EXIT INT TERM

if [ ! -f "$DSH_BIN" ]; then
  check dsh-prefix fail "missing $DSH_BIN"
  echo "RESULT version=$VERSION failed=$FAILED"
  exit 1
fi

# --- per-version preset ----------------------------------------------------
# The checked-in preset is generated from one dsh's standard.patch.yml. A user
# on another version runs `dsh-cad-setup`, which regenerates it from THAT
# version. Link the checkout into a writable overlay so setup can write in the box
# host, then let the profile link to the copy.
PLUGIN_COPY="$HOST_HOME/plugin"
mkdir -p "$PLUGIN_COPY/presets/cad"
LINK_FAILED=0
for entry in "$PLUGIN_ROOT"/* "$PLUGIN_ROOT"/.[!.]*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  [ "$name" = presets ] && continue
  ln -s "$entry" "$PLUGIN_COPY/$name" 2>/dev/null || LINK_FAILED=1
done
# `presets` must be a real directory (setup writes preset.patch.yml into it);
# its other files stay linked to the read-only checkout.
for entry in "$PLUGIN_ROOT"/presets/cad/*; do
  [ -e "$entry" ] || continue
  name=$(basename "$entry")
  [ "$name" = preset.patch.yml ] && continue
  ln -s "$entry" "$PLUGIN_COPY/presets/cad/$name" 2>/dev/null || LINK_FAILED=1
done

if [ "$LINK_FAILED" -eq 0 ]; then
  STANDARD=$(node -e 'const { createRequire } = require("node:module"); const r = createRequire(process.argv[1]); process.stdout.write(r.resolve("@deepseek-ai/dsh-web-app/presets/standard.patch.yml"))' "$DSH_BIN" 2>/dev/null)
  [ -n "$STANDARD" ] || STANDARD=$(find "$DSH_PREFIX/node_modules" -path '*/dsh-web-app/presets/standard.patch.yml' 2>/dev/null | head -n 1)
  if [ -n "$STANDARD" ] && [ -f "$PLUGIN_COPY/scripts/setup.mjs" ]; then
    if DSH_HOME="$DSH_HOME" node "$PLUGIN_COPY/scripts/setup.mjs" --root "$PLUGIN_COPY" --standard "$STANDARD" --openscad=off --kernel openscad --no-interactive > "$LOG_DIR/$VERSION.setup.out" 2> "$LOG_DIR/$VERSION.setup.err"; then
      check setup pass "preset regenerated from this dsh's standard.patch.yml"
    else
      check setup fail "dsh-cad-setup failed (see $LOG_DIR/$VERSION.setup.err)"
    fi
  else
    check setup fail "standard.patch.yml not found under $DSH_PREFIX/node_modules"
  fi
else
  check setup fail "could not link the checkout into the box (see $LOG_DIR/$VERSION.copy.err)"
fi

# --- profile ---------------------------------------------------------------
mkdir -p "$PROFILE/node_modules"
ln -s "$PLUGIN_COPY" "$PROFILE/node_modules/dsh-cad-harness"
node -e '
  const fs = require("node:fs");
  const [file, plugin] = process.argv.slice(1);
  fs.writeFileSync(file, `${JSON.stringify({
    name: "dsh-profile-matrix",
    private: true,
    dependencies: { "dsh-cad-harness": `link:${plugin}` },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-cad-harness"] } },
  }, null, 2)}\n`);
' "$PROFILE/package.json" "$PLUGIN_COPY" || check profile fail "could not write $PROFILE/package.json"

if [ ! -f "$PROFILE/package.json" ]; then
  echo "RESULT version=$VERSION failed=$FAILED"
  exit 1
fi

# --- expected markers and tools -------------------------------------------
MARKERS=$(node -e 'process.stdout.write(require(process.argv[1]).markers.join(" "))' "$CONFIG" 2>/dev/null)
TOOLS=$(node -e 'process.stdout.write(require(process.argv[1]).cadTools.join(" "))' "$CONFIG" 2>/dev/null)
if [ -z "$MARKERS" ] || [ -z "$TOOLS" ]; then
  check config fail "could not read markers/cadTools from $CONFIG"
  echo "RESULT version=$VERSION failed=$FAILED"
  exit 1
fi
MARKER_COUNT=$(printf '%s\n' $MARKERS | wc -w | tr -d ' ')
TOOL_COUNT=$(printf '%s\n' $TOOLS | wc -w | tr -d ' ')

# --- T0/T1: version + composition -----------------------------------------
GOT=$(node "$DSH_BIN" --version 2>/dev/null | head -n 1)
if [ "$GOT" = "$VERSION" ]; then
  check binary pass "dsh --version = $GOT"
else
  check binary fail "want $VERSION got ${GOT:-<none>}"
fi

# Same semantics as dsh-app-boot: engines.dsh with includePrerelease.
RANGE=$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.engines?.dsh ?? p.cad?.dshRuntime ?? "")' "$PLUGIN_COPY/package.json" 2>/dev/null)
if [ -n "$RANGE" ] && node -e 'const s=require(process.argv[1]); process.exit(s.satisfies(process.argv[2], process.argv[3], {includePrerelease:true}) ? 0 : 1)' "$DSH_PREFIX/node_modules/semver" "$GOT" "$RANGE" 2>/dev/null; then
  check engines pass "$GOT satisfies $RANGE"
else
  check engines fail "${GOT:-<none>} does not satisfy ${RANGE:-<missing engines.dsh>}"
fi

DUMP_LOG="$LOG_DIR/$VERSION.dump.yml"
DUMP_ERR="$LOG_DIR/$VERSION.dump.err"
if DSH_HOME="$DSH_HOME" node "$DSH_BIN" --profile matrix --dump-config > "$DUMP_LOG" 2> "$DUMP_ERR"; then
  HIT=0
  for marker in $MARKERS; do
    if grep -q -- "$marker" "$DUMP_LOG"; then HIT=$((HIT + 1)); fi
  done
  if [ "$HIT" -eq "$MARKER_COUNT" ]; then
    check compose pass "$HIT/$MARKER_COUNT markers"
  else
    check compose fail "$HIT/$MARKER_COUNT markers (see $DUMP_LOG)"
  fi
else
  check compose fail "dump-config exited nonzero (see $DUMP_ERR)"
fi

# --- mock model helpers ----------------------------------------------------
wait_for_mock() {
  # The mock prints one listening line; poll briefly instead of a fixed sleep.
  tries=0
  while [ "$tries" -lt 50 ]; do
    if grep -q "accept-dsh-matrix-mock" "$1" 2>/dev/null; then return 0; fi
    tries=$((tries + 1))
    sleep 0.1
  done
  return 1
}

start_mock() {
  mode=$1
  port=$2
  log=$3
  node "$MOCK" "$mode" "$port" "$log" > "$LOG_DIR/$VERSION.$mode.mock.log" 2>&1 &
  MOCK_PID=$!
  wait_for_mock "$LOG_DIR/$VERSION.$mode.mock.log" || check "mock-$mode" fail "did not start on $port"
}

stop_mock() {
  if [ -n "$MOCK_PID" ]; then
    kill "$MOCK_PID" 2>/dev/null || true
    wait "$MOCK_PID" 2>/dev/null || true
    MOCK_PID=
  fi
}

run_dsh() {
  port=$1
  out=$2
  err=$3
  prompt=$4
  DSH_HOME="$DSH_HOME" DEEPSEEK_API_KEY=matrix DEEPSEEK_BASE_URL="http://127.0.0.1:$port" \
    node "$DSH_BIN" --profile matrix --json "$prompt" > "$out" 2> "$err"
}

# --- T2: one turn that both offers and executes a CAD tool -----------------
PORT=$((PORT_BASE + 1))
start_mock tool "$PORT" "$LOG_DIR/$VERSION.tool.req.log"
if run_dsh "$PORT" "$LOG_DIR/$VERSION.tool.out" "$LOG_DIR/$VERSION.tool.err" "call cad_session info"; then
  check boot pass "headless turn completed"
else
  check boot fail "headless turn exited nonzero (see $LOG_DIR/$VERSION.tool.err)"
fi
stop_mock

TOOLS_HIT=0
for tool in $TOOLS; do
  if grep -q "\"name\":\"$tool\"" "$LOG_DIR/$VERSION.tool.req.log" 2>/dev/null; then
    TOOLS_HIT=$((TOOLS_HIT + 1))
  fi
done
if [ "$TOOLS_HIT" -eq "$TOOL_COUNT" ]; then
  check tools pass "$TOOLS_HIT/$TOOL_COUNT CAD tools in model request"
else
  check tools fail "$TOOLS_HIT/$TOOL_COUNT CAD tools in model request"
fi

if grep -q '"type":"tool_call"'  "$LOG_DIR/$VERSION.tool.out" 2>/dev/null \
  && grep -q '"tool":"cad_session"' "$LOG_DIR/$VERSION.tool.out" 2>/dev/null; then
  check tool-call pass "cad_session invoked"
else
  check tool-call fail "cad_session was not invoked"
fi
if grep -q '"type":"tool_result"' "$LOG_DIR/$VERSION.tool.out" 2>/dev/null \
  && grep -q '"status":"completed"' "$LOG_DIR/$VERSION.tool.out" 2>/dev/null \
  && grep -q 'kernel' "$LOG_DIR/$VERSION.tool.out" 2>/dev/null; then
  check tool-result pass "cad_session info returned a kernel"
else
  check tool-result fail "cad_session did not complete with a kernel result"
fi
if grep -q '"text":"tool-ok"' "$LOG_DIR/$VERSION.tool.out" 2>/dev/null; then
  check tool-final pass "tool-ok"
else
  check tool-final fail "no final tool-ok"
fi

echo "RESULT version=$VERSION failed=$FAILED"
exit "$FAILED"
