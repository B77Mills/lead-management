const run = require('../_run');
const command = require('../../src/commands/upsert-identity-records');

run(command, {
  records: [
    { EmailAddress: 'jacob.bare@gmail.com' },
    { EmailAddress: 'jacob@limit0.io', FirstName: 'Jacob', LastName: 'Bare' },
    { EmailAddress: 'jeff@ien.com' },
    { EmailAddress: 'jenna@ien.com' },
  ],
})
  .catch((e) => setImmediate(() => { throw e; }));