module.exports = {
  apps: [{
    name: 'billing-proxy',
    script: './dist/server.js',
    instances: 3,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
