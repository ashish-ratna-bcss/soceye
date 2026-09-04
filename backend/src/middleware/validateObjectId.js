const mongoose = require('mongoose');

// Rejects a malformed :id before it reaches a controller's findById/findByIdAndUpdate/
// findByIdAndDelete — without this, an invalid id throws a Mongoose CastError whose
// message embeds the field name and model name, and several controllers echo
// `err.message` straight back to the client.
const validateObjectIdParam = (paramName = 'id') => (req, res, next, value) => {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    return res.status(400).json({ success: false, message: `Invalid ${paramName}` });
  }
  next();
};

module.exports = { validateObjectIdParam };
