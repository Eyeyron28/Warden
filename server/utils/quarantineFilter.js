/** Add to any query that reads files for display: leaves out files held in Quarantine (utils/quarantine.js). A document with no
 * `quarantine` field (everything uploaded before Quarantine existed) is not held, so it matches. Kept alone, with no requires, so any
 * module (the emergency scope included) can use it. */
const NOT_HELD = Object.freeze({ 'quarantine.state': { $ne: 'held' } });

module.exports = { NOT_HELD };
