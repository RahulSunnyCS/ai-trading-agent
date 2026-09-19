module.exports = {
  testEnvironment: "node",
  testMatch: ["**/tests/**/*.test.js"],
  collectCoverageFrom: [
    "brokers/**/*.js",
    "utils/**/*.js",
    "checkDates.js",
    "updateSheet.js",
    "parser.js",
  ],
};
