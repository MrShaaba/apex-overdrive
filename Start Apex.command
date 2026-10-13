#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
if ! command -v node >/dev/null 2>&1; then
  print 'Install Node.js 22.12 or newer, then launch Apex again.'
  read '?Press Return to close.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci
fi
if [[ ! -f dist/index.html ]]; then
  npm run build
fi
print 'Apex opens at http://127.0.0.1:4173. Keep this window open while playing.'
npm start
