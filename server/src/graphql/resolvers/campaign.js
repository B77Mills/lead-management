const { Pagination, TypeAhead, paginationResolvers } = require('@limit0/mongoose-graphql-pagination');
const { gql } = require('apollo-server-express');
const moment = require('moment');
const fetch = require('node-fetch');
const csvToJson = require('csvtojson');
const { get } = require('object-path');
const campaignLineItemCriteria = require('../../gam-graphql/campaign-line-item-criteria');
const gamLoadMany = require('../utils/gam-load-many');
const emptyConnection = require('../../gam-graphql/empty-connection');
const Campaign = require('../../models/campaign');
const Identity = require('../../models/identity');
const FormRepo = require('../../repos/form');
const AdCreativeTracker = require('../../models/ad-creative-tracker');
const emailReportService = require('../../services/email-report');
const adReportService = require('../../services/ad-report');
const identityAttributes = require('../../services/identity-attributes');
const redis = require('../../redis');
const getBrightcoveReport = require('../utils/brightcove-get-report');

const { isArray } = Array;

const hasKeys = (value) => Boolean(Object.keys(value).length);

const calcMax = (auth, max) => {
  if (!auth.isAdmin() && (!max || max < 1 || max > 200)) return 200;
  if (auth.isAdmin() && (!max || max < 0)) return 0;
  return max;
};

const findEmailCampaign = async (id) => {
  const record = await Campaign.findOne({ 'email._id': id || null, deleted: false });
  if (!record) throw new Error(`No campaign record found for ID ${id}.`);
  return record;
};

const findFormCampaign = async (id) => {
  const record = await Campaign.findOne({ 'forms._id': id || null, deleted: false });
  if (!record) throw new Error(`No campaign record found for ID ${id}.`);
  return record;
};

const findAdCampaign = async (id) => {
  const record = await Campaign.findOne({ 'ads._id': id || null, deleted: false });
  if (!record) throw new Error(`No campaign record found for ID ${id}.`);
  return record;
};

const handleExcludedFields = (excludeFields, auth) => {
  let fields = [];
  if (isArray(excludeFields)) {
    fields = fields.concat(excludeFields);
  }
  if (!auth.isAdmin()) {
    const toRestrict = identityAttributes.filter((f) => f.adminOnly).map((f) => f.key);
    fields = fields.concat(toRestrict);
  }
  return [...new Set(fields)];
};

const pollReportStatus = async ({ reportJobId, gam }) => {
  const { data } = await gam({
    document: gql`
      query CheckLineItemReportStatus($reportJobId: BigInt!) {
        getReportJobStatus(input: { reportJobId: $reportJobId })
      }
    `,
    variables: { reportJobId },
  });
  const { getReportJobStatus: status } = data;
  if (status === 'IN_PROGRESS') return pollReportStatus({ reportJobId, gam });
  if (status === 'COMPLETED') return true;
  if (status === 'FAILED') throw new Error('Report creation failed!');
  throw new Error(`Unknown report status encountered: '${status}'`);
};

module.exports = {
  /**
   *
   */
  CampaignConnection: paginationResolvers.connection,

  /**
   *
   */
  EmailCampaignIdentityConnection: paginationResolvers.connection,

  /**
   *
   */
  AdCampaignIdentityConnection: paginationResolvers.connection,

  /**
   *
   */
  Campaign: {
    customer: (campaign, _, { loaders }) => loaders.customer.load(campaign.customerId),

    gamLineItems: async (campaign, { input }, context, info) => {
      const { loaders } = context;
      const { startDate, endDate } = campaign;
      const { gamAdvertiserIds } = await loaders.customer.load(campaign.customerId);
      if (!isArray(gamAdvertiserIds) || !gamAdvertiserIds.length) return emptyConnection();
      return gamLoadMany({
        ...input,
        type: 'lineItem',
        criteria: campaignLineItemCriteria({ startDate, endDate, gamAdvertiserIds }),
        context,
        info,
      });
    },

    /**
     * @todo need to determine how to exhaust the connection when paginated
     */
    gamLineItemReport: async (campaign, _, context, info) => {
      const { loaders, gam } = context;
      const { startDate, endDate } = campaign;

      const excludedIds = campaign.get('adMetrics.excludedGAMLineItemIds');
      const filterResponse = (rows) => rows.filter((row) => {
        const lineItemId = get(row, 'Dimension.LINE_ITEM_ID');
        return !excludedIds.includes(lineItemId);
      });

      const emptyResponse = [];

      const cacheKey = `campaign:gam-line-item-report:${campaign.id}`;

      const setToCache = async (result) => {
        const data = JSON.stringify(result);
        // store for one hour
        await redis.setexAsync(cacheKey, 60 * 60, data);
      };

      const fromCache = await redis.getAsync(cacheKey);
      if (fromCache) return filterResponse(JSON.parse(fromCache));

      const { gamAdvertiserIds } = await loaders.customer.load(campaign.customerId);
      if (!isArray(gamAdvertiserIds) || !gamAdvertiserIds.length) {
        await setToCache(emptyResponse);
        return emptyResponse;
      }
      const { nodes } = await gamLoadMany({
        type: 'lineItem',
        criteria: campaignLineItemCriteria({ startDate, endDate, gamAdvertiserIds }),
        limit: 500,
        context,
        info,
        fields: 'nodes { id }',
      });
      if (!nodes.length) {
        await setToCache(emptyResponse);
        return emptyResponse;
      }
      const lineItemIds = nodes.map((node) => node.id);

      const now = new Date();

      // handle campaigns without start or end dates.
      const start = startDate || moment().subtract(5, 'years');
      const end = endDate || now;
      const variables = {
        startDate: moment(start).format('YYYY-MM-DD'),
        // GAM does not support end dates greater than the current date
        endDate: moment(end > now ? now : end).format('YYYY-MM-DD'),
        query: `WHERE LINE_ITEM_ID IN (${lineItemIds.join(',')})`,
      };

      const { data: jobData } = await gam({
        document: gql`
          query RunLineItemReportJob($startDate: GAMDate!, $endDate: GAMDate!, $query: String!) {
            runReportJob(input: {
              reportJob: {
                reportQuery: {
                  dimensions: [ADVERTISER_ID, ADVERTISER_NAME, ORDER_ID, ORDER_NAME, LINE_ITEM_ID, LINE_ITEM_NAME, LINE_ITEM_TYPE, CREATIVE_TYPE, CREATIVE_SIZE]
                  dimensionAttributes: [LINE_ITEM_START_DATE_TIME, LINE_ITEM_END_DATE_TIME]
                  columns: [AD_SERVER_IMPRESSIONS, AD_SERVER_CLICKS, AD_SERVER_CTR]
                  dateRangeType: CUSTOM_DATE
                  startDate: $startDate
                  endDate: $endDate
                  statement: { query: $query }
                }
              }
            }) {
              id
            }
          }
        `,
        variables,
      });
      const { id: reportJobId } = jobData.runReportJob;
      await pollReportStatus({ reportJobId, gam });
      const { data: downloadData } = await gam({
        document: gql`
          query CheckLineItemReportDownload($reportJobId: BigInt!) {
            getReportDownloadUrlWithOptions(input: {
              reportJobId: $reportJobId
              reportDownloadOptions: { exportFormat: CSV_DUMP, useGzipCompression: false }
            })
          }
        `,
        variables: { reportJobId },
      });
      const { getReportDownloadUrlWithOptions: downloadUrl } = downloadData;
      const res = await fetch(downloadUrl, { method: 'GET' });
      const json = await csvToJson().fromStream(res.body);
      await setToCache(json);
      return filterResponse(json);
    },

    /**
     *
     */
    brightcoveVideoReport: async (campaign, _, { brightcove, loaders }) => {
      const { startDate, endDate } = campaign;
      const excludedIds = campaign.get('adMetrics.excludedGAMLineItemIds');
      const { brightcoveVideoIds } = await loaders.customer.load(campaign.customerId);
      const emptyResponse = {
        totalCount: 0,
        nodes: [],
        pageInfo: { hasNextPage: false, hasPreviousPage: false },
      };
      if (!brightcoveVideoIds || !brightcoveVideoIds.length) return emptyResponse;
      const videoIds = brightcoveVideoIds.filter((id) => !excludedIds.includes(id));
      if (!videoIds.length) return emptyResponse;

      const now = new Date();
      // handle campaigns without start or end dates.
      const start = startDate || moment().subtract(5, 'years').toDate();
      const end = endDate || now;

      return getBrightcoveReport({
        dimensions: ['video'],
        where: [{ key: 'video', values: videoIds }],
        fields: [
          'video_name',
          'video_impression',
          'video_view',
          'engagement_score',
          'video_engagement_25',
          'video_engagement_50',
          'video_engagement_75',
          'video_engagement_100',
          'video_percent_viewed',
        ],
        sort: [{ field: 'video_view', order: 'desc' }],
        limit: 100,
        from: start,
        to: end > now ? now : end,
      }, { brightcove });
    },
  },

  /**
   *
   */
  CampaignAdMetrics: {
    /**
     *
     */
    excludedGAMLineItemIds: ({ excludedGAMLineItemIds: ids }) => (isArray(ids) ? ids : []),
  },

  EmailCampaignUrl: {
    deployment: (sendUrl, _, { loaders }) => loaders.emailDeployment.load(sendUrl.deploymentId),
    send: (sendUrl, _, { loaders }) => loaders.emailSend.load(sendUrl.sendId),
    url: (sendUrl, _, { loaders }) => loaders.extractedUrl.load(sendUrl.urlId),
    active: () => true,
  },

  EmailCampaignUrlGroup: {
    id: (urlGroup) => urlGroup.urlId,
    url: (urlGroup, _, { loaders }) => loaders.extractedUrl.load(urlGroup.urlId),
    deploymentGroups: (urlGroup) => {
      const { sendUrls, excludeUrls } = urlGroup;

      const map = sendUrls.reduce((obj, emailSend) => {
        const { deploymentId } = emailSend;
        // eslint-disable-next-line no-param-reassign
        if (!obj[deploymentId]) obj[deploymentId] = [];
        obj[deploymentId].push({ emailSend, excludeUrls });
        return obj;
      }, {});
      return Object.keys(map).reduce((arr, deploymentId) => {
        arr.push({ deploymentId, sendUrls: map[deploymentId] });
        return arr;
      }, []);
    },
  },

  EmailCampaignUrlDeploymentGroup: {
    deployment: ({ deploymentId }, _, { loaders }) => loaders.emailDeployment.load(deploymentId),
    sendGroups: (deploymentGroup) => deploymentGroup.sendUrls,
  },

  EmailCampaignUrlSendGroup: {
    id: (sendGroup) => sendGroup.emailSend.id,
    send: (sendGroup, _, { loaders }) => loaders.emailSend.load(sendGroup.emailSend.sendId),
    active: (sendGroup) => {
      const { emailSend, excludeUrls } = sendGroup;
      const found = excludeUrls.find((e) => `${e.urlId}` === `${emailSend.urlId}` && `${e.sendId}` === `${emailSend.sendId}`);
      if (found) return false;
      return true;
    },
  },

  /**
   *
   */
  EmailCampaign: {
    tags: ({ tagIds }, _, { loaders }) => loaders.tag.loadMany(tagIds),
    excludedTags: ({ excludedTagIds }, _, { loaders }) => loaders.tag.loadMany(excludedTagIds),
    urls: async (emailCampaign) => {
      const { id } = emailCampaign;
      const campaign = await Campaign.findOne({ 'email._id': id });
      if (!campaign) return [];

      return emailReportService.findAllUrlsForCampaign(campaign);
    },

    urlCount: async (emailCampaign) => {
      const { id } = emailCampaign;
      const campaign = await Campaign.findOne({ 'email._id': id });
      if (!campaign) return 0;

      const urls = await emailReportService.findAllUrlsForCampaign(campaign);
      const urlIds = urls.map((url) => `${url.id}`);
      return urlIds.length;
    },

    urlGroups: async (emailCampaign) => {
      const { id } = emailCampaign;
      const campaign = await Campaign.findOne({ 'email._id': id });
      if (!campaign) return [];

      const excludeUrls = emailCampaign.excludeUrls || [];
      const emailSends = await emailReportService.findAllUrlSendsForCampaign(campaign);
      const map = emailSends.reduce((obj, emailSend) => {
        const { urlId } = emailSend;
        // eslint-disable-next-line no-param-reassign
        if (!obj[urlId]) obj[urlId] = [];
        obj[urlId].push(emailSend);
        return obj;
      }, {});
      return Object.keys(map).reduce((arr, urlId) => {
        arr.push({ urlId, sendUrls: map[urlId], excludeUrls });
        return arr;
      }, []);
    },

    excludeUrls: (emailCampaign) => {
      if (!Array.isArray(emailCampaign.excludeUrls)) return [];
      return emailCampaign;
    },

    excludeFields: (emailCampaign) => emailCampaign.getExcludeFields(),

    hasEmailSends: async (emailCampaign) => {
      const { id } = emailCampaign;
      const campaign = await Campaign.findOne({ 'email._id': id });
      if (!campaign) return false;
      const { sendIds } = await emailReportService.getEligibleUrlAndSendIds(campaign);
      return Boolean(sendIds.length);
    },
  },

  /**
   *
   */
  EmailCampaignExcludedUrl: {
    url: (excluded, _, { loaders }) => loaders.extractedUrl.load(excluded.urlId),
    send: (excluded, _, { loaders }) => loaders.emailSend.load(excluded.sendId),
  },

  /**
   *
   */
  AdCampaign: {
    tags: ({ tagIds }, _, { loaders }) => loaders.tag.loadMany(tagIds),
    trackers: async (adCampaign) => {
      const { id } = adCampaign;
      const campaign = await Campaign.findOne({ 'ads._id': id });
      if (!campaign) return [];
      return adReportService.findAllTrackersForCampaign(campaign);
    },
    excludeTrackers: (adCampaign) => {
      const { excludeTrackerIds } = adCampaign;
      if (!Array.isArray(excludeTrackerIds)) return [];
      return AdCreativeTracker.find({ _id: { $in: excludeTrackerIds } });
    },
    hasIdentities: async (adCampaign) => {
      const { id } = adCampaign;
      const campaign = await Campaign.findOne({ 'ads._id': id });
      if (!campaign) return false;
      const identityIds = await adReportService.getEligibleIdentityIds(campaign);
      return Boolean(identityIds.length);
    },
  },

  FormCampaign: {
    forms: async (formCampaign, { refreshEntries }) => {
      const { id, excludeFormIds } = formCampaign;
      const campaign = await Campaign.findOne({ 'forms._id': id });

      const forms = await FormRepo.getEligibleCampaignForms(campaign, { refreshEntries });
      const exclude = Array.isArray(excludeFormIds) ? excludeFormIds.map((formId) => `${formId}`) : [];
      return forms.map((form) => ({ id: form.id, form, active: !exclude.includes(`${form.id}`) }));
    },
  },

  /**
   *
   */
  Query: {
    /**
     *
     */
    campaign: async (root, { input }, { auth }) => {
      auth.check();
      const { id } = input;
      const record = await Campaign.findOne({ _id: id || null, deleted: false });
      if (!record) throw new Error(`No campaign record found for ID ${id}.`);
      return record;
    },

    /**
     *
     */
    campaignByHash: async (root, { hash }) => {
      const record = await Campaign.findOne({ hash: hash || null, deleted: false });
      if (!record) throw new Error(`No campaign found for hash '${hash}'`);
      return record;
    },

    emailCampaign: async (root, { input }, { auth }) => {
      auth.check();
      const { id } = input;
      const campaign = await findEmailCampaign(id);
      return campaign.email;
    },

    formCampaign: async (root, { input }, { auth }) => {
      auth.check();
      const { id } = input;
      const campaign = await findFormCampaign(id);
      return campaign.forms;
    },

    adCampaign: async (root, { input }, { auth }) => {
      auth.check();
      const { id } = input;
      const campaign = await findAdCampaign(id);
      return campaign.ads;
    },

    /**
     *
     */
    allCampaigns: (root, { input, pagination, sort }, { auth }) => {
      auth.check();
      const { customerIds, starting, ending } = input;

      const startDate = {
        ...(starting.before && { $lte: starting.before }),
        ...(starting.after && { $gte: starting.after }),
      };
      const endDate = {
        ...(ending.before && { $lte: ending.before }),
        ...(ending.after && { $gte: ending.after }),
      };

      const criteria = {
        deleted: false,
        ...(customerIds.length && { customerId: { $in: customerIds } }),
        ...(hasKeys(startDate) && { startDate }),
        ...(hasKeys(endDate) && { endDate }),
      };
      return new Pagination(Campaign, { pagination, sort, criteria });
    },

    /**
     *
     */
    searchCampaigns: (root, {
      input,
      pagination,
      search,
      options,
    }, { auth }) => {
      auth.check();
      const { field, phrase } = search;
      const { customerIds, starting, ending } = input;

      const startDate = {
        ...(starting.before && { $lte: starting.before }),
        ...(starting.after && { $gte: starting.after }),
      };
      const endDate = {
        ...(ending.before && { $lte: ending.before }),
        ...(ending.after && { $gte: ending.after }),
      };

      const criteria = {
        deleted: false,
        ...(customerIds.length && { customerId: { $in: customerIds } }),
        ...(hasKeys(startDate) && { startDate }),
        ...(hasKeys(endDate) && { endDate }),
      };
      const instance = new TypeAhead(field, phrase, criteria, options);
      return instance.paginate(Campaign, pagination);
    },

    /**
     *
     */
    emailCampaignIdentities: async (root, { id, pagination, sort }, { auth }) => {
      auth.check();
      const campaign = await findEmailCampaign(id);

      const { identityIds } = await emailReportService.getClickEventIdentifiers(campaign, {
        suppressInactives: false,
      });
      const criteria = { _id: { $in: identityIds } };
      return new Pagination(Identity, { pagination, sort, criteria });
    },

    /**
     *
     */
    searchEmailCampaignIdentities: async (root, {
      id,
      pagination,
      search,
      options,
    }, { auth }) => {
      auth.check();
      const { field, phrase } = search;

      const campaign = await findEmailCampaign(id);

      const { identityIds } = await emailReportService.getClickEventIdentifiers(campaign, {
        suppressInactives: false,
      });
      const criteria = { _id: { $in: identityIds } };

      const instance = new TypeAhead(field, phrase, criteria, options);
      return instance.paginate(Identity, pagination);
    },

    /**
     *
     */
    adCampaignIdentities: async (root, { id, pagination, sort }, { auth }) => {
      auth.check();
      const campaign = await findAdCampaign(id);

      const identityIds = await adReportService.getEligibleIdentityIds(campaign, {
        suppressInactives: false,
      });
      const criteria = { _id: { $in: identityIds } };
      return new Pagination(Identity, { pagination, sort, criteria });
    },

    /**
     *
     */
    searchAdCampaignIdentities: async (root, {
      id,
      pagination,
      search,
      options,
    }, { auth }) => {
      auth.check();
      const { field, phrase } = search;

      const campaign = await findAdCampaign(id);

      const identityIds = await adReportService.getEligibleIdentityIds(campaign, {
        suppressInactives: false,
      });
      const criteria = { _id: { $in: identityIds } };

      const instance = new TypeAhead(field, phrase, criteria, options);
      return instance.paginate(Identity, pagination);
    },
  },

  /**
   *
   */
  Mutation: {
    /**
     *
     */
    adMetricsExcludedGAMLineItemIds: async (_, { input }, { auth }) => {
      auth.check();
      const { id, excludedIds } = input;
      const campaign = await Campaign.findOne({ _id: id, deleted: false });
      if (!campaign) throw new Error(`No campaign record found for ID ${id}.`);
      campaign.set('adMetrics.excludedGAMLineItemIds', excludedIds);
      return campaign.save();
    },

    /**
     *
     */
    adMetricsCampaignStatus: async (root, { input }, { auth }) => {
      auth.check();
      const { id, enabled } = input;
      const campaign = await Campaign.findOne({ _id: id, deleted: false });
      if (!campaign) throw new Error(`No campaign record found for ID ${id}.`);
      campaign.set('adMetrics.enabled', enabled);
      return campaign.save();
    },

    /**
     *
     */
    videoMetricsExcludedBrightcoveVideoIds: async (_, { input }, { auth }) => {
      auth.check();
      const { id, excludedIds } = input;
      const campaign = await Campaign.findOne({ _id: id, deleted: false });
      if (!campaign) throw new Error(`No campaign record found for ID ${id}.`);
      campaign.set('videoMetrics.excludedBrightcoveVideoIds', excludedIds);
      return campaign.save();
    },

    /**
     *
     */
    videoMetricsCampaignStatus: async (root, { input }, { auth }) => {
      auth.check();
      const { id, enabled } = input;
      const campaign = await Campaign.findOne({ _id: id, deleted: false });
      if (!campaign) throw new Error(`No campaign record found for ID ${id}.`);
      campaign.set('videoMetrics.enabled', enabled);
      return campaign.save();
    },

    /**
     *
     */
    createCampaign: (root, { input }, { auth }) => {
      auth.check();
      const {
        customerId,
        name,
        startDate,
        endDate,
        maxIdentities,
      } = input;

      const record = new Campaign({
        customerId,
        name,
        startDate,
        endDate,
        maxIdentities: calcMax(auth, maxIdentities),
      });
      return record.save();
    },

    /**
     *
     */
    cloneCampaign: async (root, { input }, { auth }) => {
      auth.check();
      const { id } = input;

      const record = await Campaign.findOne({ _id: id || null, deleted: false });
      if (!record) throw new Error(`No campaign record found for ID ${id}.`);

      const obj = record.toObject({
        getters: true,
        versionKey: false,
      });
      delete obj._id;
      delete obj.hash;
      delete obj.createdAt;
      delete obj.updatedAt;

      return Campaign.create(obj);
    },

    /**
     *
     */
    updateCampaign: async (root, { input }, { auth }) => {
      auth.check();
      const { id, payload } = input;
      const {
        customerId,
        name,
        startDate,
        endDate,
        maxIdentities,
      } = payload;

      const record = await Campaign.findOne({ _id: id || null, deleted: false });
      if (!record) throw new Error(`No campaign record found for ID ${id}.`);
      record.set({
        customerId,
        name,
        startDate,
        endDate,
        maxIdentities: calcMax(auth, maxIdentities),
      });
      return record.save();
    },

    /**
     *
     */
    deleteCampaign: async (root, { input }, { auth }) => {
      auth.check();
      const { id } = input;
      const record = await Campaign.findById(id);
      if (!record) throw new Error(`No campaign record found for ID ${id}.`);
      record.deleted = true;
      await record.save();
      return 'ok';
    },

    /**
     *
     */
    emailCampaignTags: async (root, { input }, { auth }) => {
      auth.check();
      const { id, tagIds } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.tagIds', tagIds);
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    emailCampaignExcludedTags: async (root, { input }, { auth }) => {
      auth.check();
      const { id, tagIds } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.excludedTagIds', tagIds);
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    emailCampaignLinkTypes: async (root, { input }, { auth }) => {
      auth.check();
      const { id, linkTypes } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.allowedLinkTypes', linkTypes);
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    emailCampaignExcludedFields: async (root, { input }, { auth }) => {
      auth.check();
      const { id, excludeFields } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.excludeFields', handleExcludedFields(excludeFields, auth));
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    emailCampaignIdentityFilters: async (root, { input }, { auth }) => {
      auth.check();
      const { id, filters } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.identityFilters', filters);
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    emailCampaignExcludedUrls: async (root, { input }, { auth }) => {
      auth.check();
      const { id, excludeUrls } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.excludeUrls', excludeUrls.filter((e) => e.active === false));
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    formCampaignExcludedForms: async (root, { input }, { auth }) => {
      auth.check();
      const { id, excludeForms } = input;
      const campaign = await findFormCampaign(id);
      campaign.set('forms.excludeFormIds', excludeForms.filter((e) => e.active === false).map((e) => e.formId));
      await campaign.save();
      return campaign.forms;
    },

    /**
     *
     */
    emailCampaignStatus: async (root, { input }, { auth }) => {
      auth.check();
      const { id, enabled } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.enabled', enabled);
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    emailCampaignRestrictSentDate: async (root, { input }, { auth }) => {
      auth.check();
      const { id, restrictToSentDate } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.restrictToSentDate', restrictToSentDate);
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    emailCampaignDisplayDeliveredMetrics: async (root, { input }, { auth }) => {
      auth.check();
      const { id, displayDeliveredMetrics } = input;
      const campaign = await findEmailCampaign(id);
      campaign.set('email.displayDeliveredMetrics', displayDeliveredMetrics);
      await campaign.save();
      return campaign.email;
    },

    /**
     *
     */
    formCampaignStatus: async (root, { input }, { auth }) => {
      auth.check();
      const { id, enabled } = input;
      const campaign = await findFormCampaign(id);
      campaign.set('forms.enabled', enabled);
      await campaign.save();
      return campaign.forms;
    },

    /**
     *
     */
    adCampaignStatus: async (root, { input }, { auth }) => {
      auth.check();
      const { id, enabled } = input;
      const campaign = await findAdCampaign(id);
      campaign.set('ads.enabled', enabled);
      await campaign.save();
      return campaign.ads;
    },

    /**
     *
     */
    adCampaignTags: async (root, { input }, { auth }) => {
      auth.check();
      const { id, tagIds } = input;
      const campaign = await findAdCampaign(id);
      campaign.set('ads.tagIds', tagIds);
      await campaign.save();
      return campaign.ads;
    },

    /**
     *
     */
    adCampaignExcludedFields: async (root, { input }, { auth }) => {
      auth.check();
      const { id, excludeFields } = input;
      const campaign = await findAdCampaign(id);
      campaign.set('ads.excludeFields', handleExcludedFields(excludeFields, auth));
      await campaign.save();
      return campaign.ads;
    },

    /**
     *
     */
    adCampaignIdentityFilters: async (root, { input }, { auth }) => {
      auth.check();
      const { id, filters } = input;
      const campaign = await findAdCampaign(id);
      campaign.set('ads.identityFilters', filters);
      await campaign.save();
      return campaign.ads;
    },

    /**
     *
     */
    adCampaignExcludedTrackers: async (root, { input }, { auth }) => {
      auth.check();
      const { id, excludeTrackerIds } = input;
      const campaign = await findAdCampaign(id);
      campaign.set('ads.excludeTrackerIds', excludeTrackerIds);
      await campaign.save();
      return campaign.ads;
    },

  },
};
