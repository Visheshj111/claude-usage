/// <reference types="vite/client" />
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const inpageCss = readFileSync(resolve(__dirname, '../inpage.css'), 'utf8');

it('uses the locally bundled Outfit font for the in-page widget and refiner', () => {
  const style = document.createElement('style');
  style.textContent = inpageCss;
  document.head.append(style);

  expect(getComputedStyle(document.documentElement).getPropertyValue('--cut-font')).toContain('Outfit');
  expect(inpageCss).toContain("url('../fonts/outfit-latin-wght-normal.woff2')");
});
