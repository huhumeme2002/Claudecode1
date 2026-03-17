module.exports = {
  apps: [{
    name: 'billing-proxy',
    script: './dist/server.js',
    instances: 5,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
