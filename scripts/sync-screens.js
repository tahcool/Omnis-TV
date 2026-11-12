// Copies the shared TV screen page and logo from the main Omnis project into the TV app,
// so there is only one copy of the screens to maintain (systems/fleetrack/kiosk.html).
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');
const ROOT = path.join(APP, '..', '..');
const files = [
  ['systems/fleetrack/kiosk.html', 'systems/fleetrack/kiosk.html'],
  ['assets/images/omnis-logo.png', 'assets/images/omnis-logo.png'],
  ['assets/images/omnis-logo-white.png', 'assets/images/omnis-logo-white.png'],
  ['assets/images/omnis-notification-icon.png', 'assets/images/omnis-notification-icon.png'],
];
for (const [from, to] of files) {
  const src = path.join(ROOT, from), dst = path.join(APP, to);
  if (!fs.existsSync(src)) { console.error('[sync-screens] missing ' + src); process.exit(1); }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('[sync-screens] ' + from);
}

