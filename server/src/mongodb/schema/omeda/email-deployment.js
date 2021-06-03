const { Schema } = require('mongoose');

const schema = new Schema({
  entity: { type: String },
  urlIds: [{ type: Schema.Types.ObjectId }],
  omeda: { type: Schema.Types.Mixed },
}, { timestamps: true });

schema.index({ entity: 1 }, { unique: true });
schema.index({ 'omeda.Status': 1 });
schema.index({ 'omeda.SentDate': 1 });

module.exports = schema;
