import test from 'node:test';
import assert from 'node:assert/strict';
import eject from '../usb-eject.js';

test('eject plans only target removable volumes', () => {
  assert.deepEqual(eject.ejectPlan('/Volumes/LEDSTICK/POWERLED', 'darwin').args, ['eject', '/Volumes/LEDSTICK']);
  assert.equal(eject.ejectPlan('/Users/me/Desktop', 'darwin'), null);
  assert.equal(eject.ejectPlan('/', 'darwin'), null);
  assert.equal(eject.ejectPlan('/media/me/STICK', 'linux').mount, '/media/me/STICK');
  assert.equal(eject.ejectPlan('/home/me', 'linux'), null);
  assert.equal(eject.ejectPlan('E:\\POWERLED', 'win32').mount, 'E:');
});
