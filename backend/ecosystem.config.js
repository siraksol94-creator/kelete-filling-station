module.exports = {
  apps: [
    {
      name: 'kelete',
      script: 'server-tenant.js',
      cwd: '/var/www/kelete-pos-tenant/backend',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        TENANT_PORT: 5300,
        // VPS_URL not needed on the VPS itself — only used by device sync clients
      },
    },
  ],
};
