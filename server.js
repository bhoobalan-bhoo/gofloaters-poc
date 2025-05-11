const serverless = require('serverless-http');
const app = require('./app');

const port = 3007;

app.listen(port, () => {
    console.log(`listening at http://localhost:${port}`);
});

module.exports.handler = serverless(app);
