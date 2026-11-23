const { resolve } = require('node:path');
const checkout = process.env.ATOMIC_SERVER_CHECKOUT;
if (!checkout) throw new Error('Set ATOMIC_SERVER_CHECKOUT to the built, patched Atomic plugin host.');
const base = require(resolve(checkout, 'browser/e2e/playwright.config.ts')).default;
const chromium = base.projects.find(project => project.name === 'chromium');
module.exports = {
  ...base,
  testDir: './test',
  testMatch: 'atomic-plugin.playwright.cjs',
  outputDir: '/tmp/rs-atomic-native-results',
  retries: 0,
  workers: 1,
  reporter: [['list']],
  projects: [{
    ...chromium,
    use: {
      ...chromium.use,
      launchOptions: {
        ...chromium.use.launchOptions,
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      },
    },
  }],
};
