module.exports = {
  apps: [{
    name: 'billing-proxy',
    script: './dist/server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
