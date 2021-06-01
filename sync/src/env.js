const {
  cleanEnv,
  str,
} = require('envalid');

module.exports = cleanEnv(process.env, {
  LEGACY_MONGO_DSN: str({ desc: 'The legacy "leads-graph" MongoDB DSN to connect to.' }),
  MONGO_DSN: str({ desc: 'The MongoDB DSN to connect to.' }),
  OMEDA_APP_ID: str({ desc: 'The Omeda API App ID.' }),
  OMEDA_BRAND_KEY: str({ desc: 'The Omeda brand database key.' }),
  TENANT_KEY: str({ desc: 'The current tenant key' }),
});