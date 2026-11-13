// Parts of Loop that are switched off while they are being redone. Their code
// stays; with a switch off the part does not start, and the window hides it.
// Settings saved for them (paired phones, servers) are kept as they are.
module.exports = Object.freeze({
  phone: false, // working on sessions from the phone app, and the relay to it
  servers: false, // running sessions on another machine over SSH
});
