module.exports = {
  apps: [{
    name: 'lexa',
    script: 'src/index.js',
    node_args: '--env-file=.env',
    autorestart: true,
    max_restarts: 20,
    restart_delay: 5000,
    time: true,
  }],
};
