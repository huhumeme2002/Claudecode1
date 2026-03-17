module.exports = {
  apps: [
    {
      name: 'billing-proxy',
      script: './dist/server.js',
      instances: 5,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'admin-api',
      script: './dist/server-admin.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        ADMIN_PORT: '3001'
      }
    }
  ]
};
