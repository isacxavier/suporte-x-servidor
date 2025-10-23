// Thin entrypoint for hosting platforms that expect `node server.js` at repo root.
// Delegates to the actual server implementation in the `server/` directory.
require('./server/server.js');
