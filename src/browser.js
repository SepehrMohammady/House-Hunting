/**
 * Shared browser launch settings for the two sources that need a real Chromium.
 *
 * The headless decision cannot come from config alone. `headless: false` is the
 * right default on a desktop - a visible window is markedly harder for DataDome
 * to fingerprint - but on a server there is no display at all, and asking for a
 * visible window there fails the launch outright rather than degrading. So the
 * config expresses the preference and this checks whether it is achievable.
 *
 * If you want the harder-to-detect visible mode on a server, run the service
 * under `xvfb-run`, which provides a virtual display; DISPLAY is then set and
 * this returns headless:false on its own.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROFILE_DIR = path.resolve(__dirname, '..', 'data', '.browser-profile');

/** True when a visible window is actually possible on this machine. */
export function hasDisplay() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/**
 * Resolve headless mode. `preferHeadless` is the config value.
 * A request for a visible window is honoured only if one can exist.
 */
export function resolveHeadless(preferHeadless) {
  if (preferHeadless === true) return true;
  return !hasDisplay();
}

/** The launch options both sources share. */
export function launchOptions(preferHeadless) {
  return {
    headless: resolveHeadless(preferHeadless),
    viewport: { width: 1440, height: 900 },
    locale: 'it-IT',
    timezoneId: 'Europe/Rome',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: [
      // Removes the main automation giveaway DataDome checks for.
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      // Servers often have a small /dev/shm; without this Chromium can crash.
      '--disable-dev-shm-usage',
    ],
  };
}
