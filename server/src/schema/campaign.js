const { Schema } = require('mongoose');
const moment = require('moment-timezone');
const importPlugin = require('../plugins/import');
const hashablePlugin = require('../plugins/hashable');
const connection = require('../mongoose');
const redis = require('../redis');
const newrelic = require('../newrelic');
const identityAttributes = require('../services/identity-attributes');

const identityFilterSchema = new Schema({
  key: {
    type: String,
  },
  label: {
    type: String,
  },
  matchType: {
    type: String,
    default: 'matches',
  },
  terms: {
    type: [String],
  },
});

const excludeUrlSchema = new Schema({
  urlId: {
    type: Schema.Types.ObjectId,
    validate: {
      async validator(v) {
        const doc = await connection.model('extracted-url').findOne({ _id: v }, { _id: 1 });
        if (doc) return true;
        return false;
      },
      message: 'No URL was found for {VALUE}',
    },
  },
  sendId: {
    type: Schema.Types.ObjectId,
    validate: {
      async validator(v) {
        const doc = await connection.model('email-send').findOne({ _id: v }, { _id: 1 });
        if (doc) return true;
        return false;
      },
      message: 'No email send was found for {VALUE}',
    },
  },
});

const formsSchema = new Schema({
  enabled: {
    type: Boolean,
    required: true,
    default: true,
  },
  excludeFormIds: [{
    type: Schema.Types.ObjectId,
    ref: 'form',
  }],
});

const adMetricsSchema = new Schema({
  enabled: {
    type: Boolean,
    required: true,
    default: true,
  },
  excludedGAMLineItemIds: {
    type: [String],
    default: [],
  },
});

const videoMetricsSchema = new Schema({
  enabled: {
    type: Boolean,
    required: true,
    default: true,
  },
  excludedBrightcoveVideoIds: {
    type: [String],
    default: [],
  },
});

const adsSchema = new Schema({
  enabled: {
    type: Boolean,
    required: true,
    default: true,
  },
  tagIds: [
    {
      type: Schema.Types.ObjectId,
      validate: {
        async validator(v) {
          const doc = await connection.model('tag').findOne({ _id: v }, { _id: 1 });
          if (doc) return true;
          return false;
        },
        message: 'No tag was found for {VALUE}',
      },
    },
  ],
  excludeFields: {
    type: [String],
    default: ['phoneNumber'],
  },
  identityFilters: {
    type: [identityFilterSchema],
  },
  excludeTrackerIds: {
    type: [Schema.Types.ObjectId],
  },
});

const emailSchema = new Schema({
  enabled: {
    type: Boolean,
    required: true,
    default: true,
  },
  tagIds: [
    {
      type: Schema.Types.ObjectId,
      validate: {
        async validator(v) {
          const doc = await connection.model('tag').findOne({ _id: v }, { _id: 1 });
          if (doc) return true;
          return false;
        },
        message: 'No tag was found for {VALUE}',
      },
    },
  ],
  excludedTagIds: [
    {
      type: Schema.Types.ObjectId,
      validate: {
        async validator(v) {
          const doc = await connection.model('tag').findOne({ _id: v }, { _id: 1 });
          if (doc) return true;
          return false;
        },
        message: 'No tag was found for {VALUE}',
      },
    },
  ],
  excludeFields: {
    type: [String],
    default: ['phoneNumber'],
  },
  allowedLinkTypes: {
    type: [String],
    default: ['Advertising', '(Not Set)'],
  },
  identityFilters: {
    type: [identityFilterSchema],
  },
  excludeUrls: {
    type: [excludeUrlSchema],
  },
  restrictToSentDate: {
    type: Boolean,
    default: true,
  },
  displayDeliveredMetrics: {
    type: Boolean,
    default: false,
  },
});

emailSchema.method('getExcludeFields', async function getEmailExcludeFields() {
  const isEditorial = this.get('allowedLinkTypes').includes('Editorial');
  const tag = await connection.model('tag').findOne({ _id: { $in: this.tagIds }, name: 'PR' });
  if (!tag && !isEditorial) return this.get('excludeFields');
  return identityAttributes.filter((attr) => !['title', 'companyName'].includes(attr.key)).map((attr) => attr.key);
});

const schema = new Schema({
  name: {
    type: String,
    trim: true,
  },
  customerId: {
    type: Schema.Types.ObjectId,
    ref: 'customer',
    required: true,
    validate: {
      async validator(v) {
        const doc = await connection.model('customer').findById(v, { _id: 1 });
        if (doc) return true;
        return false;
      },
      message: 'No customer found for ID {VALUE}',
    },
  },
  fullName: {
    type: String,
    required: true,
    trim: true,
  },
  startDate: {
    type: Date,
    set: (v) => {
      if (!(v instanceof Date)) return undefined;
      return moment.tz(v, 'America/Chicago').startOf('day').toDate();
    },
  },
  endDate: {
    type: Date,
    set: (v) => {
      if (!(v instanceof Date)) return undefined;
      return moment.tz(v, 'America/Chicago').endOf('day').toDate();
    },
  },
  // @todo Ensure this is handled.
  maxIdentities: {
    type: Number,
    default: 200,
  },
  deleted: {
    type: Boolean,
    required: true,
    default: false,
  },
  email: {
    type: emailSchema,
    default: {},
  },
  forms: {
    type: formsSchema,
    default: {},
  },
  ads: {
    type: adsSchema,
    default: {},
  },
  adMetrics: {
    type: adMetricsSchema,
    default: {},
  },
  videoMetrics: {
    type: videoMetricsSchema,
    default: {},
  },
}, { timestamps: true });

schema.plugin(hashablePlugin);
schema.plugin(importPlugin);

schema.index({ deleted: 1 });
schema.index({ fullName: 'text' });
schema.index({ 'email._id': 1 });
schema.index({ fullName: 1, _id: 1 }, { unique: true });
schema.index({ fullName: -1, _id: -1 }, { unique: true });
schema.index({ updatedAt: 1, _id: 1 }, { unique: true });
schema.index({ updatedAt: -1, _id: -1 }, { unique: true });

schema.statics.findByHash = async function findByHash(hash, deleted = false) {
  const campaign = await this.findOne({ hash: hash || null, deleted });
  if (!campaign) throw new Error(`No campaign found for hash '${hash}'`);
  return campaign;
};

schema.methods.createFullName = async function createFullName() {
  const {
    name,
    customerId,
    startDate,
    endDate,
  } = this;

  const customer = await connection.model('customer').findById(customerId, { name: 1 });
  const campaignName = name ? `: ${name}` : '';

  const format = 'MMM Do, YYYY';
  let dateName = 'Indefinite';
  if (startDate && endDate) {
    dateName = `${moment.tz(startDate, 'America/Chicago').format(format)} to ${moment.tz(endDate, 'America/Chicago').format(format)}`;
  } else if (startDate && !endDate) {
    dateName = `'Indefinite, starting ${moment.tz(startDate, 'America/Chicago').format(format)}'`;
  } else if (!startDate && endDate) {
    dateName = `Until ${moment.tz(endDate, 'America/Chicago').format(format)}`;
  }

  return `${customer.name}${campaignName} (${dateName})`;
};

schema.pre('validate', async function setFullName() {
  this.fullName = await this.createFullName();
});

schema.post('save', async function clearReportCache() {
  // clear line item report cache.
  redis.delAsync(`campaign:gam-line-item-report:${this.id}`).catch(newrelic.noticeError.bind(newrelic));
});

module.exports = schema;
