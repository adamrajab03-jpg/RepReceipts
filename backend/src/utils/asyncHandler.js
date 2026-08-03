// Wrap an async Express handler so a rejected promise — a db.connect() failure,
// a throw inside the handler's own finally, or any path that escapes its
// internal try/catch — is forwarded to the error middleware as a clean 500
// instead of becoming an unhandled rejection that crashes the process. Express 4
// does NOT do this for async handlers, so without it any escaped rejection is a
// latent server-killer.
module.exports = function asyncHandler(fn) {
  return function asyncWrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
