const { Pagination, TypeAhead, paginationResolvers } = require('@limit0/mongoose-graphql-pagination');
const Tag = require('../../models/tag');

module.exports = {
  /**
   *
   */
  TagConnection: paginationResolvers.connection,

  /**
   *
   */
  Query: {
    /**
     *
     */
    tag: async (root, { input }, { auth }) => {
      auth.check();
      const { id } = input;
      const record = await Tag.findOne({ _id: id || null, deleted: false });
      if (!record) throw new Error(`No tag record found for ID ${id}.`);
      return record;
    },

    /**
     *
     */
    allTags: (root, { pagination, sort }, { auth }) => {
      auth.check();
      const criteria = { deleted: false };
      return new Pagination(Tag, { pagination, sort, criteria });
    },

    /**
     *
     */
    searchTags: (root, { pagination, search, options }, { auth }) => {
      auth.check();
      const { field, phrase } = search;
      const instance = new TypeAhead(field, phrase, { deleted: false }, options);
      return instance.paginate(Tag, pagination);
    },
  },

  /**
   *
   */
  Mutation: {
    /**
     *
     */
    createTag: (root, { input }, { auth }) => {
      auth.checkAdmin();
      const { payload } = input;
      const { name } = payload;
      const record = new Tag({ name });
      return record.save();
    },

    /**
     *
     */
    updateTag: async (root, { input }, { auth }) => {
      auth.checkAdmin();
      const { id, payload } = input;
      const { name } = payload;
      const record = await Tag.findOne({ _id: id || null, deleted: false });
      if (!record) throw new Error(`No tag record found for ID ${id}.`);
      record.set({ name });
      return record.save();
    },

    /**
     *
     */
    deleteTag: async (root, { input }, { auth }) => {
      auth.checkAdmin();
      const { id } = input;
      const record = await Tag.findById(id);
      if (!record) throw new Error(`No tag record found for ID ${id}.`);
      record.deleted = true;
      await record.save();
      return 'ok';
    },
  },
};
