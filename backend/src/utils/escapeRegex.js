// Escapes regex metacharacters so user input can be safely embedded in a
// Mongo $regex filter (prevents NoSQL "operator" abuse via crafted patterns
// and ReDoS from unescaped quantifiers).
const escapeRegex = (string) => String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { escapeRegex };
