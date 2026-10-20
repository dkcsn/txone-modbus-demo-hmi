const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Without a Developer ID, electron-builder leaves Electron's own signature (identifier
// "Electron"), so macOS never offers the Local Network permission. Re-sign ad hoc
// under the app's bundle identifier instead.
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  // codesign rejects bundles carrying Finder info or file-provider attributes (for example
  // inside an iCloud-synced Documents folder), so sign a clean copy in a temporary folder.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmi-sign-'));
  const cleanCopy = path.join(workDir, path.basename(appPath));
  try {
    execFileSync('ditto', ['--norsrc', '--noextattr', '--noqtn', appPath, cleanCopy]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', cleanCopy], { stdio: 'inherit' });
    fs.rmSync(appPath, { recursive: true, force: true });
    execFileSync('ditto', ['--norsrc', cleanCopy, appPath]);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};
