#!/bin/zsh
# REE Investigation Studio launcher. Loopback only; it does not install software.
set -u
cd -- "${0:A:h}" || {
  print -u2 "REE couldn't open its folder. Keep Start-REE-Studio.command in the REE checkout."
  exit 1
}
if ! command -v node >/dev/null 2>&1; then
  print ""
  print "REE needs Node.js before the studio can start."
  print "Nothing was installed or changed."
  print "Read the setup guide: rel/MAC_SETUP.md"
  if [[ -t 0 ]]; then
    print "Press Enter to close this window."
    read -r ignored || true
  fi
  exit 1
fi
print ""
print "REE Investigation Studio"
print "-----------------------------------------"
print "Local only. No account, no upload, and no target is launched by opening the studio."
print "Static analysis needs a prior npm ci and npm run build:cached in this checkout."
print ""
print "Checking this Mac (read-only)..."
node ree.mjs doctor
print ""
print "Opening the studio on 127.0.0.1."
print "Keep this Terminal window open; press Control+C to stop."
exec node ree.mjs studio --open
