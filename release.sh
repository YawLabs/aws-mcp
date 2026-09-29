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

# --- CHANGELOG promotion (ported from ctxlint) ---------------------------
# These scripts never promoted the [Unreleased] heading, so documented work
# accumulated there and shipped versions went out undocumented -- the cause of
# seven backfilled entries across this fleet on 2026-08-23. The promotion then
# skipped any release with nothing under [Unreleased], and step 6 took the
# GitHub release notes from commit subjects regardless, so ten versions shipped
# on 2026-09-13 with no changelog entry and subject-list release notes.
#
# Every release now gets a `## [<version>]` entry, and step 6 sources the
# release notes from it:
#   * [Unreleased] has content -> it becomes the version section, and a fresh,
#     empty [Unreleased] heading is left above it for the next change.
#   * [Unreleased] is empty or absent -> a version section is generated from
#     the commit subjects since the previous tag. Raw subjects are less than a
#     hand-written entry, but a version with no entry at all reads as a mistake.
#   * The Keep-a-Changelog link references at the bottom, when the file has
#     them, are moved along: [Unreleased] compares from the new tag, and the
#     version gets its own compare link.

changelog_section() {
  [ -f CHANGELOG.md ] || return 0
  awk -v heading="$1" '
    index($0, "## [" heading "]") == 1 { capture=1; next }
    capture && /^## \[/ { exit }
    capture { print }
  ' CHANGELOG.md
}

# True when a section body carries any non-whitespace content.
changelog_nonempty() { [ -n "$(echo "$1" | tr -d '[:space:]')" ]; }

# Reuse whatever separator this file already puts between version and date.
# The fleet mixes an em-dash and "--"; promoting with a hardcoded one would
# introduce a third style into whichever repos do not use it.
changelog_dash() {
  local d
  d=$(sed -nE 's/^## \[[0-9][^]]*\][[:space:]]+([^[:space:]]+)[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}.*/\1/p' CHANGELOG.md 2>/dev/null | head -1)
  if [ -n "$d" ]; then printf '%s' "$d"; else printf '%s' '--'; fi
}

# The tag this release is compared against: the newest v* tag reachable from
# HEAD other than this release's own (a re-run after tagging must not compare
# the version with itself). Empty on a first release.
changelog_prev_tag() {
  git describe --tags --abbrev=0 --match 'v*' --exclude "v${VERSION}" 2>/dev/null || true
}

# The body of a generated entry: one bullet per commit subject since the
# previous tag, newest first, with version-bump commits dropped.
changelog_generated_body() {
  local prev=$1 range subjects
  if [ -n "$prev" ]; then range="${prev}..HEAD"; else range="HEAD"; fi
  subjects=$(git log --no-merges --format='%s' "$range" 2>/dev/null \
    | grep -vE '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^/- /' || true)
  [ -n "$subjects" ] || subjects="- Maintenance release; no changes since ${prev:-the previous release}."
  printf '### Changed\n%s\n' "$subjects"
}

# Keep-a-Changelog link references, when the file uses them: [Unreleased]
# compares from the new tag, and the version gets its own compare link (or a
# tag link on a first release). A version link that already exists is kept.
changelog_update_links() {
  local prev=$1 tmp
  grep -qE '^\[Unreleased\]: .*/compare/.*\.\.\.HEAD' CHANGELOG.md || return 0
  tmp=$(mktemp)
  awk -v ver="$VERSION" -v prev="$prev" -v have_link="$(grep -c "^\[${VERSION}\]: " CHANGELOG.md || true)" '
    !done && /^\[Unreleased\]: .*\/compare\/.*\.\.\.HEAD/ {
      url=$0; sub(/^\[Unreleased\]: /, "", url); sub(/\/compare\/.*$/, "", url)
      print "[Unreleased]: " url "/compare/v" ver "...HEAD"
      if (have_link == 0) {
        if (prev != "") print "[" ver "]: " url "/compare/" prev "...v" ver
        else print "[" ver "]: " url "/releases/tag/v" ver
      }
      done=1; next
    }
    { print }
  ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md link update failed"; }
  mv "$tmp" CHANGELOG.md
}

# Make sure `## [<version>] <dash> <today>` exists: promote [Unreleased] when it
# has content, otherwise generate the section from the commit subjects.
promote_changelog() {
  [ -f CHANGELOG.md ] || return 0
  local prev
  prev=$(changelog_prev_tag)
  if changelog_nonempty "$(changelog_section "$VERSION")"; then
    info "CHANGELOG.md already has an entry for v${VERSION}"
    changelog_update_links "$prev"
    return 0
  fi
  local today tmp dash heading body
  today=$(date +%F)
  dash=$(changelog_dash)
  heading="## [${VERSION}] ${dash} ${today}"
  tmp=$(mktemp)
  if changelog_nonempty "$(changelog_section "Unreleased")"; then
    # Rewrite only the FIRST [Unreleased] heading: a stray later mention (a link
    # reference, a quoted example) must not become a second, bogus heading.
    awk -v repl="$heading" '
      !promoted && index($0, "## [Unreleased]") == 1 { print "## [Unreleased]"; print ""; print repl; promoted=1; next }
      { print }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md promotion failed"; }
    info "CHANGELOG.md: promoted [Unreleased] -> [${VERSION}] ${dash} ${today}"
  else
    body=$(changelog_generated_body "$prev")
    warn "CHANGELOG.md has no [Unreleased] content -- writing [${VERSION}] from the commit subjects since ${prev:-the first commit}; edit it if they undersell the release"
    # Insert below an empty [Unreleased] heading, else above the first version
    # heading, else at the end of the file.
    awk -v heading="$heading" -v body="$body" '
      !done && index($0, "## [Unreleased]") == 1 { print; print ""; print heading; print ""; print body; done=1; next }
      !done && /^## \[/ { print heading; print ""; print body; print ""; done=1 }
      { print }
      END { if (!done) { print ""; print heading; print ""; print body } }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md entry generation failed"; }
    info "CHANGELOG.md: added [${VERSION}] ${dash} ${today} from commit subjects"
  fi
  mv "$tmp" CHANGELOG.md
  changelog_update_links "$prev"
}

# Backstop for the promotion above: every release has an entry now, so a
# missing one means promote_changelog did not run or did not land, and the
# release notes in step 6 would silently fall back to commit subjects.
assert_changelog_promoted() {
  [ -f CHANGELOG.md ] || return 0
  changelog_nonempty "$(changelog_section "$VERSION")" && return 0
  fail "CHANGELOG.md has no '## [${VERSION}]' entry -- promote_changelog did not run or did not land."
}

# Release notes for step 6: the version's changelog section, trimmed of the
# blank lines around it; commit subjects only when there is no changelog.
release_notes() {
  local notes
  notes=$(changelog_section "$VERSION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
  if changelog_nonempty "$notes"; then
    printf '%s\n' "$notes"
  elif [ -n "${1:-}" ] && [ "$1" != "v${VERSION}" ]; then
    git log --oneline "${1}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /'
  else
    printf 'Initial release\n'
  fi
}

# True when npm itself serves @yawlabs/aws-mcp@${VERSION}: a 200 from the
# per-version document, the exact URL the MCP Registry's validator fetches. NOT
# `npm view`: that reads the whole packument, which registry.npmjs.org serves
# from Cloudflare's edge for up to 300 s (Cache-Control: public, max-age=300;
# measured 2026-09-28 still HIT with no-cache request headers), so right after a
# publish it can keep saying the version is absent. The per-version document is
# served uncached (CF-Cache-Status DYNAMIC). The `_` query is belt-and-braces
# against that changing; npm ignores it. Probe-only: any failure reads as "not
# served".
npm_version_live() {
  local code
  if command -v curl >/dev/null 2>&1; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
      -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
      "https://registry.npmjs.org/@yawlabs%2Faws-mcp/${VERSION}?_=$(date +%s)${RANDOM}" 2>/dev/null || true)
    [ "$code" = "200" ]
  else
    [ "$(npm view "@yawlabs/aws-mcp@${VERSION}" version --prefer-online 2>/dev/null || echo "")" = "$VERSION" ]
  fi
}

# SKIP_LINT=1 escape hatch -- wraps `npm`/`pnpm` so lint-related runs are
# no-ops.
#
# THIS SHOULD NOW BE UNNECESSARY, and reaching for it is a signal something
# regressed. `npm run lint` routes through scripts/lint.mjs, whose job is
# narrow: when the native biome binary for THIS host is unusable, provision and
# run the x64 build OF THE SAME VERSION under emulation. Verified: `npm run
# lint` exits 0 on Windows ARM64.
#
# The earlier text here blamed "the MINGW64-ARM64 npm-run-script wrapper" and
# justified skipping with "CI catches lint regressions anyway". Both were wrong.
# `npm run` is fine on that host (a plain node script through the same wrapper
# exits 0); the crash comes from `@biomejs/cli-win32-arm64/biome.exe` itself,
# reproducible by invoking that binary directly with no npm in the picture.
#
# But it is PER-VERSION and CHECK-shaped, not a standing arm64 defect: 2.5.4 --
# the version this repo installs -- exits 139 / 0xC0000005 on a check run while
# answering `--version` with exit 0, whereas 2.4.16 and 2.5.13 run correctly on
# the same host (measured 2026-09-11). So "the binary starts" is never evidence
# the gate works, and a future bump may need no emulation at all.
#
# And this repo ships NO CI by design -- there is no .github/workflows, and
# `gh api repos/YawLabs/aws-mcp/actions/permissions --jq .enabled` returns false
# (checked 2026-09-11) -- so nothing downstream re-checks formatting. Skipping
# the lint step means the release is published unlinted, full stop.
#
# So: only set SKIP_LINT=1 if scripts/lint.mjs cannot produce a result at all,
# and treat that as a bug to fix rather than a step to routinely skip.
#
# SKIP_TEST=1 is the parallel escape hatch for `npm test` / `npm run test*`.
# Apply only when local tests are unreliable due to PLATFORM issues -- not
# code issues. The known case: Windows ARM64 subprocess-timing flakes in
# aws-cli.integration / sso.integration / auth.test that race on event-loop
# scheduling under sustained laptop load.
#
# Same correction as above applies: this text used to say "CI on standard
# runners is the authoritative test check", and there is no CI. Skipping the
# tests means publishing untested, with nothing downstream to catch it.
#
# A timing flake is also worth diagnosing rather than skipping past, because
# green-when-serialized is a specific and cheap signal:
#   node --test --test-concurrency=1 "dist/**/*.test.js"
# Green serialized + red parallel means a fixed-duration assumption is racing
# `node --test`'s parallel file execution -- find that assertion and widen or
# re-anchor it. Judge by failure RATE over several runs; one red run proves as
# little as one green one.
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
# --- oam floor preflight -------------------------------------------------
# The policy is that the launcher's floor is the latest oam release and the server
# is verified on that one release. oam ships often enough that this goes stale
# between releases on its own: 0.16.3 was published two hours before the 2.5.0
# release that pinned it. So ask before publishing rather than discovering it in a
# bug report.
#
# The DRIFT half of this check (does the whole repo agree on the floor?) needs no
# network and runs in the test suite instead, so step 2 already covers it.
#
# Exits non-zero when the floor is behind; AWS_MCP_ALLOW_STALE_OAM=1 is the
# deliberate way past it. A machine with no network is not a failure -- the check
# says so and continues.
if [ -f scripts/check-oam-floor.mjs ]; then
  echo ""
  node scripts/check-oam-floor.mjs || fail "oam floor check failed -- see above. Set AWS_MCP_ALLOW_STALE_OAM=1 to release on the old floor deliberately."
fi

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
# There is no CI, so this is the only run of the whole suite that is guaranteed
# to happen before a publish -- and the opt-in real-CLI suites
# (*.realcli.test.ts, the ones that wait out real timeouts and retries) are the
# only tests that check the fake CLI's claims against the AWS CLI actually
# installed here. They add a minute or two and need nothing but loopback; the
# fast real-CLI suites already run on every `npm test`. Respects an explicit
# AWS_MCP_REAL_CLI_TESTS=0 for a box with no AWS CLI v2, where every such suite
# skips itself anyway.
export AWS_MCP_REAL_CLI_TESTS="${AWS_MCP_REAL_CLI_TESTS:-1}"
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

# Promote the heading BEFORE the bump commit, so the rewrite is committed
# with the version bump rather than left dirty in the working tree.
promote_changelog
assert_changelog_promoted

step 4 "Commit, tag, and push"
if [ "$IS_CI" = "true" ]; then
  info "CI mode — skipping commit/tag/push (already tagged)"
else
  BUMP_FILES="package.json package-lock.json"
  [ -f CHANGELOG.md ] && BUMP_FILES="$BUMP_FILES CHANGELOG.md"
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
if npm_version_live; then PUBLISHED_VERSION="$VERSION"; else PUBLISHED_VERSION=""; fi
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm — skipping"
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/aws-mcp@${VERSION} to npm (with provenance)"
else
  # No CI publish path -- workstation is the publisher. Retry up to 3 times
  # on EOTP/EAUTH/OTP only (WebAuthn-fresh sessions sometimes need ~30s for
  # the auth backend to propagate); an E403 over an existing version is the
  # already-published case (below); fail fast on everything else so a
  # packaging error doesn't waste 60s spinning.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  NPM_ALREADY_THERE=false
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    # npm's own word that the version is already there: the E403 "You
    # cannot publish over the previously published versions". Reachable
    # when the skip check above missed a version npm holds -- its read
    # path lagging the write, or this host unable to read it -- which is
    # the state an immediate re-run after a failed later step starts from.
    # Treated as the skip it should have been, not as a token problem.
    if grep -q 'cannot publish over the previously published versions' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      NPM_ALREADY_THERE=true
      break
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above).

  If the error was E401 or E404, the automation token in ~/.npmrc is dead.
  npm answers an UNAUTHORIZED PUT with 404, not 401, so 'could not be found
  or you do not have permission' here almost always means 'not authorized'
  -- the package is fine. Confirm which it is:

      npm whoami          # E401 => the token is dead

  Fix: mint a NEW automation token (npmjs.com -> Access Tokens -> Generate
  -> Automation), then write these two lines to ~/.npmrc:

      @yawlabs:registry=https://registry.npmjs.org/
      //registry.npmjs.org/:_authToken=npm_YOURTOKEN

  Do NOT run 'npm login --auth-type=web'. It OVERWRITES the automation token
  with a 2FA-bound web session; the next publish then EOTPs on a WebAuthn
  challenge, and any CI sharing that token starts failing too."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  if [ "$NPM_ALREADY_THERE" = "true" ]; then
    warn "npm already holds @yawlabs/aws-mcp@${VERSION} (its E403 said so) though the pre-publish read did not show it -- treating the publish as done"
  else
    info "Published @yawlabs/aws-mcp@${VERSION} to npm (workstation)"
  fi
fi

step 6 "Create GitHub release"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists — skipping"
else
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  # --notes-file, never --notes: the notes come from a CHANGELOG entry, and this
  # release's was long enough that passing it through argv died with "Argument
  # list too long" (exit 126) AFTER npm had published -- so the release had to be
  # finished by hand. A file has no such limit on any platform. (Windows caps a
  # command line at 32,767 characters, which one thorough entry can reach.)
  NOTES_FILE=$(mktemp)
  # shellcheck disable=SC2064  # expand NOTES_FILE now, not at trap time
  trap "rm -f '$NOTES_FILE'" EXIT
  release_notes "$PREV_TAG" > "$NOTES_FILE"

  gh release create "v${VERSION}" \
    --title "v${VERSION}" \
    --notes-file "$NOTES_FILE"
  info "GitHub release created (notes from CHANGELOG.md [${VERSION}])"
fi

# --- npm propagation gate (part of step 7, deliberately not a step of its own) ---
#
# `npm publish` returns as soon as the registry ACCEPTS the tarball, but the
# version is not immediately readable from the CDN-backed read path. The MCP
# Registry validates by READING the package, so step 7 has failed with
# "version 'X' was not found (status: 404)" on three consecutive releases
# (2.2.0, 2.2.1, 2.2.2). Each recovered by waiting and re-running the whole
# script -- i.e. every release cost two invocations and a human in the loop.
#
# Polling here makes one invocation enough. Two deliberate choices:
#
#   * npm_version_live (curl), not `npm view`. `npm view` reads the whole
#     packument, which Cloudflare's edge caches for up to 5 min, so a poll
#     through it can keep reporting the pre-publish answer well after the
#     version is live -- the loop would then outlast the condition it is waiting
#     on. The helper reads the same URL the MCP Registry itself validates
#     against, so a success here is evidence about the exact path that was
#     failing.
#   * WARN, never fail, on timeout. If propagation is genuinely stuck, letting
#     mcp-publisher run produces its own precise error naming the version and
#     status; a timeout message from this loop would replace that with something
#     strictly less informative. This gate can only make the release faster,
#     never worse than it was before it existed.
#   * The scope slash is percent-encoded (`@yawlabs%2Faws-mcp`, the `@` left
#     bare): that is the exact URL the MCP Registry's npm validator builds
#     (url.PathEscape in internal/validators/registries/npm.go), so this poll
#     reads the same document it does, as the sibling release scripts do.
#     The literal-slash spelling also resolves, but can be a different entry.
if [ "${SKIP_NPM_WAIT:-}" = "1" ]; then
  warn "SKIP_NPM_WAIT=1 -- not waiting for npm to serve v${VERSION}"
elif ! command -v curl >/dev/null 2>&1; then
  warn "curl not found -- skipping the npm propagation wait; step 7 may 404 on a fresh publish"
else
  PKG_NAME=$(node -p "require('./package.json').name")
  NPM_WAIT_TIMEOUT_S=${NPM_WAIT_TIMEOUT_S:-300}
  NPM_WAITED_S=0
  # 5s: this is a remote read on a minutes-scale wait, so a tighter spin buys
  # nothing. (Under MSYS every `sleep` forks a process -- ~0.1s each -- which is
  # noise at this interval but the reason not to poll sub-second.)
  while [ "$NPM_WAITED_S" -lt "$NPM_WAIT_TIMEOUT_S" ]; do
    if npm_version_live; then
      break
    fi
    sleep 5
    NPM_WAITED_S=$((NPM_WAITED_S + 5))
  done
  if [ "$NPM_WAITED_S" -ge "$NPM_WAIT_TIMEOUT_S" ]; then
    warn "npm still does not serve ${PKG_NAME}@${VERSION} after ${NPM_WAIT_TIMEOUT_S}s -- continuing anyway so the registry step can report the precise error"
  elif [ "$NPM_WAITED_S" -gt 0 ]; then
    info "npm is serving v${VERSION} (waited ${NPM_WAITED_S}s for propagation)"
  else
    info "npm is already serving v${VERSION}"
  fi
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
  # Up to four attempts, 30 s, 60 s, then 90 s apart, and ONLY for the
  # shape waiting cures. The npm gate above reads npm from THIS machine's
  # CDN edge, so it can go green while the MCP Registry's own read still
  # lags (ctxlint v0.27.0 needed the 3rd of 3 retries, ~150 s after the
  # publish). The live registry (v1.8.1; wording from registry PR #1411)
  # answers that lag with "exists, but version '<v>' was not found
  # (status: 404)", and a bad moment on npm's side with "... Likely
  # transient, retry later" (429, 5xx, an inconclusive 404) or "failed to
  # fetch package metadata from NPM" (no status at all). Every other
  # failure -- bad server.json, namespace not owned, auth -- fails the same
  # after any wait, so it stops on the first attempt. A duplicate version
  # means an earlier run already registered it: the state this step wants.
  # The registry's OWN transient answers are retried on the same clock too:
  # HTTP 429, 502, 503 or 504 on the publish call. Cutting @yawlabs/mcp 1.0.17
  # (2026-09-29) met a 504 from the registry's nginx gateway while its search
  # requests were timing out -- the registry was slow, not saying no. A retry
  # is safe even when the timed-out attempt landed: it then meets the
  # duplicate-version branch below.
  MCP_PUBLISH_LOG=$(mktemp)
  MCP_DONE=false
  MCP_ATTEMPT=1
  MCP_MAX_ATTEMPTS=4
  MCP_GATEWAY_RETRIED=false
  while true; do
    if "$MP" publish 2>&1 | tee "$MCP_PUBLISH_LOG"; then
      MCP_DONE=true
      break
    fi
    if grep -qiE 'duplicate version|already exists' "$MCP_PUBLISH_LOG"; then
      if [ "$MCP_GATEWAY_RETRIED" = "true" ]; then
        info "MCP Registry refused the retry of ${VERSION} as a duplicate: the attempt that timed out landed"
      else
        info "MCP Registry already has ${VERSION} -- nothing to publish"
      fi
      MCP_DONE=true
      break
    fi
    # The registry's own 429/502/503/504 on the publish call, if that is what
    # this attempt got: empty otherwise. `|| true` because no match is the
    # normal case, and the failing grep would then make the assignment fail,
    # which `set -e` turns into the end of the script.
    MCP_GATEWAY_STATUS=$(grep -oE 'server returned status (429|502|503|504)([^0-9]|$)' "$MCP_PUBLISH_LOG" | head -n 1 | grep -oE '[0-9]{3}' || true)
    # The not-found shape counts only when the validator's own "version '<v>'"
    # names this version. A bare version match is not enough: the registry's
    # publisher after v1.8.1 (registry main) prints "Publishing <name>@<v> to"
    # before any error, and this script downloads the latest release, so a
    # missing-package 404 would then buy all the waits.
    if ! { { grep -qE 'not found \(status: *[0-9]+\)' "$MCP_PUBLISH_LOG" && grep -qF "version '${VERSION}'" "$MCP_PUBLISH_LOG"; } \
        || grep -qE 'Likely transient, retry later|failed to fetch package metadata from NPM' "$MCP_PUBLISH_LOG" \
        || [ -n "$MCP_GATEWAY_STATUS" ]; }; then
      break
    fi
    if [ "$MCP_ATTEMPT" -ge "$MCP_MAX_ATTEMPTS" ]; then break; fi
    MCP_WAIT=$((MCP_ATTEMPT * 30))
    if [ -n "$MCP_GATEWAY_STATUS" ]; then
      MCP_GATEWAY_RETRIED=true
      warn "MCP Registry answered HTTP ${MCP_GATEWAY_STATUS} itself -- busy or timing out, not a verdict -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    else
      warn "MCP Registry cannot see @yawlabs/aws-mcp@${VERSION} on npm yet -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    fi
    sleep "$MCP_WAIT"
    # A fresh registry token before every retry: tokens last 5 minutes, and an
    # attempt that meets a timing-out gateway spends the gateway's own timeout
    # before its 504 arrives, so the waits plus four slow attempts can outlast
    # the token the login above issued -- and an expired token is a 401 that
    # fails the step.
    "$MP" login github -token "${MCP_REGISTRY_TOKEN:-}" >/dev/null 2>&1 \
      || warn "mcp-publisher login refresh failed -- the next attempt may be refused as unauthorized"
    MCP_ATTEMPT=$((MCP_ATTEMPT + 1))
  done
  rm -f "$MCP_PUBLISH_LOG"
  if [ "$MCP_DONE" = "true" ]; then
    info "Published to MCP Registry"
  else
    fail "mcp-publisher publish failed -- npm + GitHub release succeeded, but the MCP Registry did not. Retry the step (re-run the script) once the cause is identified."
  fi
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

if npm_version_live; then NPM_VERSION="$VERSION"; else NPM_VERSION=""; fi
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
