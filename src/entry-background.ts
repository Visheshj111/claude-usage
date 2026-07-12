/**
 * Background / Service Worker entry point.
 *
 * Thin bootstrap — all logic lives in src/background/.
 */

import { init } from './background/init';

if (typeof globalThis !== 'undefined') {
  init();
}
