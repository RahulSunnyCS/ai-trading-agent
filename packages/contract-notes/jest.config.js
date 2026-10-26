module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'brokers/**/*.js',
    'utils/**/*.js',
    'calendar.js',
    'store.js',
    'record.js',
    'run.js',
  ],
};
