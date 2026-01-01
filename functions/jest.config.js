module.exports = {
    testEnvironment: 'node',
    coverageDirectory: 'coverage',
    collectCoverageFrom: [
        '**/*.js',
        '!**/node_modules/**',
        '!**/test/**',
        '!jest.config.js'
    ],
    testMatch: ['**/test/**/*.test.js'],
    verbose: true
};
