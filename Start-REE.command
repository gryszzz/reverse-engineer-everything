#!/bin/zsh
# REE beginner launcher. Uses only this repository's local lesson.
set -u
cd -- "${0:A:h}" || {
  print -u2 "REE couldn't open its folder. Keep Start-REE.command in the REE checkout."
  exit 1
}
if ! command -v node >/dev/null 2>&1; then
  print ""
  print "REE needs Node.js before it can start."
  print "Nothing was installed or changed."
  print "Read the setup guide: rel/MAC_SETUP.md"
  print "Then open Start-REE.command again."
  if [[ -t 0 ]]; then
    print "Press Enter to close this window."
    read -r ignored || true
  fi
  exit 1
fi
print ""
print "REE / Reverse Engineering Everything"
print "-----------------------------------------"
print "Your first mission: search for 'bridge', then press 'Show me how'."
print "No Codex account, API key, or REA build is needed for this first lesson."
print ""
print "Checking this Mac (read-only)..."
node ree.mjs doctor
print ""
print "Opening the visual lab on your own computer."
print "Keep this Terminal window open; press Control+C to stop REE."
exec node ree.mjs lab --open
