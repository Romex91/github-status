export default [
  {
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'TryStatement',
        message: 'try-catch is banned. Errors must propagate to the top-level handler (handlePost, onSSE wrapper, or global unhandledrejection). If you absolutely need try-catch, add an eslint-disable comment explaining why.',
      }],
    },
  },
];
