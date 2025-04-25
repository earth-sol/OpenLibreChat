import pluginServer from './pluginServer';
app.use(pluginServer);
const clients = require('./clients');

module.exports = {
  ...clients,
};
