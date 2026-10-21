// Works out which volume a chosen export folder lives on and ejects it. Never touches system volumes.
const { execFile } = require('node:child_process');
const path = require('node:path');

// Returns { mount, command, args } or null when the folder is not on a removable-looking volume.
function ejectPlan(dir, platform = process.platform) {
  if (platform === 'darwin') {
    const m = /^\/Volumes\/([^/]+)/.exec(dir);
    if (!m) return null;
    const mount = `/Volumes/${m[1]}`;
    return { mount, command: 'diskutil', args: ['eject', mount] };
  }
  if (platform === 'win32') {
    const m = /^([A-Za-z]):[\\/]/.exec(dir.endsWith('\\') || dir.endsWith('/') ? dir : `${dir}\\`);
    if (!m || m[1].toUpperCase() === (process.env.SystemDrive || 'C:')[0].toUpperCase()) return null;
    const drive = `${m[1].toUpperCase()}:`;
    return {
      mount: drive,
      command: 'powershell',
      args: ['-NoProfile', '-Command', `(New-Object -comObject Shell.Application).Namespace(17).ParseName('${drive}').InvokeVerb('Eject')`],
    };
  }
  const m = /^(\/media\/[^/]+\/[^/]+|\/run\/media\/[^/]+\/[^/]+|\/mnt\/[^/]+)/.exec(dir);
  if (!m) return null;
  return { mount: m[1], command: 'eject', args: [m[1]] };
}

function ejectDisk(dir) {
  const plan = ejectPlan(path.resolve(dir));
  if (!plan) return Promise.resolve({ ok: false, message: 'This folder is not on a removable disk, so it was not ejected.' });
  return new Promise((resolve) => {
    execFile(plan.command, plan.args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, message: (stderr || err.message).trim() });
      else resolve({ ok: true, message: (stdout || `Ejected ${plan.mount}`).trim() });
    });
  });
}

module.exports = { ejectPlan, ejectDisk };
