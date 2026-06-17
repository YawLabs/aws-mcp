#!/bin/bash
# =============================================================================
# Release Script — Build, tag, publish to npm, create GitHub release
# =============================================================================
# Usage:
#   ./release.sh <new-version>    — full release from local machine
#   ./release.sh                  — CI mode (derives version from git tag)
#
# If interrupted, re-run with the same version — each step is idempotent.
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# SKIP_LINT=1 escape hatch -- wraps `npm`/`pnpm` so lint-related runs are
# no-ops. Workaround for the MINGW64-ARM64 npm-run-script wrapper that
# segfaults on exit-cleanup (platform-windows.md). Apply only when the
# lint runner is broken on the host; CI catches lint regressions anyway.
#
# SKIP_TEST=1 is the parallel escape hatch for `npm test` / `npm run test*`.
# Apply only when local tests are unreliable due to PLATFORM issues -- not
# code issues. The known case: Windows ARM64 subprocess-timing flakes in
# aws-cli.integration / sso.integration / auth.test that race on event-loop
# scheduling under sustained laptop load. CI on standard runners
# (ubuntu / windows-x64 / macos) is the authoritative test check; setting
# SKIP_TEST=1 here trusts that signal instead of a flaky local one.
if [ "${SKIP_LINT:-}" = "1" ] || [ "${SKIP_TEST:-}" = "1" ]; then
  npm() {
    if [ "${SKIP_LINT:-}" = "1" ] && [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'npm run $2'"
      return 0
    fi
    if [ "${SKIP_TEST:-}" = "1" ] && { [ "$1" = "test" ] || { [ "$1" = "run" ] && [[ "$2" == test* ]]; }; }; then
      warn "SKIP_TEST=1 -- noop 'npm $*'"
      return 0
    fi
    command npm "$@"
  }
  pnpm() {
    if [ "${SKIP_LINT:-}" = "1" ] && [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'pnpm run $2'"
      return 0
    fi
    if [ "${SKIP_TEST:-}" = "1" ] && { [ "$1" = "test" ] || { [ "$1" = "run" ] && [[ "$2" == test* ]]; }; }; then
      warn "SKIP_TEST=1 -- noop 'pnpm $*'"
      return 0
    fi
    command pnpm "$@"
  }
fi

TOTAL_STEPS=9

VERSION="${1:-}"
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode — version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    echo "  e.g. ./release.sh 0.2.0"
    exit 1
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null || fail "node not installed"
command -v npm >/dev/null  || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} — resuming"
else
  if [ "$IS_CI" != "true" ]; then
    if [ -n "$(git status --porcelain)" ]; then
      fail "Working directory not clean. Commit or stash changes first."
    fi
  fi
  info "Current: v${CURRENT_VERSION} → v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Run lint + tests"
  echo "  2. Build"
  echo "  3. Bump version in package.json"
  echo "  4. Commit, tag, and push"
  echo "  5. Publish to npm"
  echo "  6. Create GitHub release"
  echo "  7. Publish to MCP Registry"
  echo "  8. Smoke test published package"
  echo "  9. Verify"
  echo ""
  if [ -t 0 ]; then
    read -p "Continue? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Aborted."
      exit 0
    fi
  else
    info "Non-interactive shell -- proceeding without confirmation"
  fi
fi

step 1 "Lint"
npm run lint || fail "Lint failed"
info "Lint passed"

step 2 "Test"
npm run build || fail "Build failed"
npm test || fail "Tests failed"
info "All tests passed"

step 3 "Bump version to $VERSION"
# Re-read from disk -- the version in $CURRENT_VERSION was captured at script
# start; if a prior interrupted run already bumped package.json, this ensures
# the skip-or-bump decision below uses the actual current value.
CURRENT_VERSION=$(node -p "require('./package.json').version")
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} — skipping"
else
  npm version "$VERSION" --no-git-tag-version
  info "package.json bumped"
fi

# server.json is published to the MCP Registry in step 7 and must match the
# tag's version. This runs UNCONDITIONALLY (not inside the bump else above)
# so a resume run where package.json was bumped in a prior invocation still
# syncs server.json -- otherwise mcp-publisher tries to re-publish the
# previous version and gets 400 "cannot publish duplicate version".
# Idempotent: the inner if skips the write when server.json is already in
# sync, so a clean re-run produces no working-tree dirt.
if [ -f server.json ]; then
  CURRENT_SERVER_VERSION=$(jq -r '.version' server.json 2>/dev/null || echo "")
  if [ "$CURRENT_SERVER_VERSION" != "$VERSION" ]; then
    jq --arg v "$VERSION" '.version = $v | .packages[0].version = $v' server.json > server.tmp
    mv server.tmp server.json
    info "server.json synced to $VERSION"
  fi
fi

step 4 "Commit, tag, and push"
if [ "$IS_CI" = "true" ]; then
  info "CI mode — skipping commit/tag/push (already tagged)"
else
  BUMP_FILES="package.json package-lock.json"
  [ -f server.json ] && BUMP_FILES="$BUMP_FILES server.json"
  if [ -n "$(git status --porcelain $BUMP_FILES 2>/dev/null)" ]; then
    git add $BUMP_FILES
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists"
  else
    # Annotated (-a) so `git push --follow-tags` below picks it up;
    # lightweight tags are ignored by --follow-tags and would silently
    # fail to publish (release commit lands but tag-push is a no-op).
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  # --follow-tags pushes only annotated tags reachable from the pushed
  # commits, not every local tag. Avoids accidentally publishing dangling
  # experimental tags that happen to be lying around.
  # Tag-drift safety: refuse to push if origin already has a tag at this name
  # pointing to a different commit (rewound tag elsewhere, parallel release race).
  # Without this check, `git push --follow-tags` SILENTLY skips updating the
  # tag on origin (the tag exists, no fast-forward happens). The main push
  # reports success, but origin's tag stays at the old SHA -- and the later
  # `gh release create` step then creates a GitHub release linked to that
  # stale commit while npm carries the new one.
  ORIGIN_TAG_SHA=$(git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | awk '{print $1}')
  if [ -n "$ORIGIN_TAG_SHA" ]; then
    LOCAL_TAG_SHA=$(git rev-parse "v${VERSION}")
    if [ "$ORIGIN_TAG_SHA" != "$LOCAL_TAG_SHA" ]; then
      fail "Tag v${VERSION} exists on origin at $ORIGIN_TAG_SHA but local tag points to $LOCAL_TAG_SHA -- resolve the drift before re-running"
    fi
  fi

  git push origin main --follow-tags
  info "Pushed to origin"
fi

step 5 "Publish to npm"
# Two publish paths, picked by environment:
#   1. IS_CI=true   -> We are running inside CI (GITHUB_REF_NAME set the
#                      version above). NODE_AUTH_TOKEN is set by the
#                      workflow; publish with --provenance for sigstore.
#   2. IS_CI=false  -> Workstation is the publisher. Try locally with
#                      EOTP retry for fresh WebAuthn sessions. (release.yml
#                      was removed at v1.3.2; there is no CI handoff path.)
PUBLISHED_VERSION=$(npm view "@yawlabs/aws-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm — skipping"
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/aws-mcp@${VERSION} to npm (with provenance)"
else
  # No CI publish path -- workstation is the publisher. Retry up to 3 times
  # on EOTP/EAUTH/OTP only (WebAuthn-fresh sessions sometimes need ~30s for
  # the auth backend to propagate); fail fast on everything else so a
  # packaging error or duplicate-version doesn't waste 60s spinning.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above). If E401/E404, your ~/.npmrc session is stale: run 'npm login --auth-type=web' and retry."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  info "Published @yawlabs/aws-mcp@${VERSION} to npm (workstation)"
fi

step 6 "Create GitHub release"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists — skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "v${VERSION}" ]; then
    CHANGELOG=$(git log --oneline "${PREV_TAG}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /')
  else
    CHANGELOG="Initial release"
  fi

  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes "$CHANGELOG"
  info "GitHub release created"
fi

step 7 "Publish to MCP Registry"
# Publishing here updates the Official MCP Registry, which is the canonical
# source MCP clients query directly. Some downstream catalogs CAN auto-source
# from the registry, but it is NOT guaranteed or universal: as of 2026-06-07,
# @yawlabs/aws-mcp had been in the registry since 2026-05-15 yet still did not
# appear on PulseMCP, and mcpservers.org/Glama presence was unconfirmed. Treat
# registry publish as necessary-but-not-sufficient for third-party catalog
# visibility -- those typically require a one-time manual submission per catalog
# and/or sync on their own (sometimes slow) schedule. server.json was already
# bumped in step 3 so the version matches the tag.
if [ ! -f server.json ]; then
  info "No server.json -- not an MCP server, skipping registry publish"
else
  # mcp-publisher binary cached at ~/.local/bin. Pinned to "latest" upstream;
  # if the registry's CLI introduces a breaking change, the next release will
  # surface it. The OS/arch detection handles Linux, macOS, and Git Bash on
  # Windows (MINGW/MSYS uname -s starts with "mingw" / "msys").
  MP="${MCP_PUBLISHER:-$HOME/.local/bin/mcp-publisher}"
  if ! [ -x "$MP" ]; then
    info "mcp-publisher not found at $MP -- downloading"
    mkdir -p "$(dirname "$MP")"
    OS_RAW=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS_RAW" in mingw*|msys*|cygwin*) OS=windows ;; *) OS="$OS_RAW" ;; esac
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    TMP=$(mktemp -d)
    curl -sL -o "$TMP/mp.tar.gz" \
      "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
      || fail "Failed to download mcp-publisher (${OS}/${ARCH})"
    tar xzf "$TMP/mp.tar.gz" -C "$TMP" || fail "Failed to extract mcp-publisher tarball"
    if [ -f "$TMP/mcp-publisher.exe" ]; then
      mv "$TMP/mcp-publisher.exe" "$MP"
    else
      mv "$TMP/mcp-publisher" "$MP"
    fi
    rm -rf "$TMP"
    chmod +x "$MP" 2>/dev/null || true
  fi

  # OIDC auth (used by the old release.yml) only works inside Actions; locally
  # we use a GitHub PAT via `login github -token <PAT>`. The PAT needs read:org
  # for YawLabs so the registry can verify org membership for the
  # io.github.YawLabs/* namespace.
  # Fall back to gh CLI's session token if MCP_REGISTRY_TOKEN is unset --
  # gh auth login (admin:org or read:org scope) covers the namespace claim.
  : "${MCP_REGISTRY_TOKEN:=$(gh auth token 2>/dev/null || true)}"
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    fail "MCP_REGISTRY_TOKEN unset -- set it to a GitHub PAT with read:org for YawLabs (or run '$MP login github' once interactively to cache the session)."
  fi
  "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null 2>&1 \
    || fail "mcp-publisher login failed -- check MCP_REGISTRY_TOKEN scopes (needs read:org for YawLabs)"
  "$MP" publish \
    || fail "mcp-publisher publish failed -- npm + GitHub release succeeded, but the MCP Registry did not. Retry the step (re-run the script) once the cause is identified."
  info "Published to MCP Registry"
fi

step 8 "Smoke test published package"
# Confirm a fresh install via npx can execute the binary and respond to
# --version. Catches packaging regressions (missing bin shebang, bad "files"
# entry, broken esbuild output) before they hit real users. Run from a temp
# dir -- if run from the checkout root, npx sees our own package.json `bin`
# entry and tries to resolve the local (unbuilt) path instead of installing
# the published tarball.
SMOKE_DIR=$(mktemp -d)
(
  cd "$SMOKE_DIR"
  # Registry propagation can lag well past a minute after publish succeeds,
  # and `npm view` and `npx` may hit different CDN paths -- v0.8.0
  # false-failed because we gated on `npm view` (which cleared) but `npx -y`
  # was still ETARGET'ing on a stale mirror. Retry the actual smoke (the npx
  # invocation itself) with a budget generous enough to outlast realistic
  # propagation. 30 * 10s = ~5min upper bound; typical case completes in <30s.
  ATTEMPTS=30
  SLEEP_SECONDS=10
  OUTPUT=""
  STARTED_AT=$(date +%s)
  for i in $(seq 1 $ATTEMPTS); do
    if OUTPUT=$(npx -y "@yawlabs/aws-mcp@${VERSION}" --version 2>/dev/null); then
      echo "  npx output: $OUTPUT (after $(( $(date +%s) - STARTED_AT ))s)"
      break
    fi
    echo "  Waiting for @yawlabs/aws-mcp@${VERSION} to be installable via npx (attempt $i/$ATTEMPTS, ${SLEEP_SECONDS}s)..."
    sleep $SLEEP_SECONDS
  done
  if [ "$OUTPUT" != "$VERSION" ]; then
    echo "  Expected $VERSION, got '$OUTPUT' after $ATTEMPTS attempts ($(( $(date +%s) - STARTED_AT ))s)" >&2
    exit 1
  fi
) || fail "Smoke test failed -- @yawlabs/aws-mcp@${VERSION} did not respond to --version with the expected value"
rm -rf "$SMOKE_DIR"
info "Smoke test passed"

step 9 "Verify"
sleep 3

NPM_VERSION=$(npm view "@yawlabs/aws-mcp@${VERSION}" version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/aws-mcp@${NPM_VERSION}"
else
  warn "npm shows ${NPM_VERSION:-nothing} (expected $VERSION — may still be propagating)"
fi

PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" = "$VERSION" ]; then
  info "package.json: ${PKG_VERSION}"
else
  warn "package.json shows ${PKG_VERSION} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

echo ""
echo -e "${GREEN}  v${VERSION} released successfully!${NC}"
echo ""
echo -e "  npm: https://www.npmjs.com/package/@yawlabs/aws-mcp"
echo -e "  git: https://github.com/YawLabs/aws-mcp/releases/tag/v${VERSION}"
echo ""
