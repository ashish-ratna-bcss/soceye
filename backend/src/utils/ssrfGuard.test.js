/**
 * Unit checks for the SSRF private-IP blocklist used by ogScraper/mediaLocationService.
 * Run: node src/utils/ssrfGuard.test.js
 */
const assert = require('assert');
const { isPrivateIp } = require('./ssrfGuard');

const run = () => {
  const privateAddresses = [
    '127.0.0.1',       // loopback
    '10.1.2.3',        // RFC1918
    '172.16.0.5',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fd00::1',
  ];
  const publicAddresses = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '203.0.113.5'];

  for (const ip of privateAddresses) {
    assert.ok(isPrivateIp(ip), `${ip} must be classified as private/internal`);
  }
  for (const ip of publicAddresses) {
    assert.ok(!isPrivateIp(ip), `${ip} must be classified as public`);
  }

  console.log('ssrfGuard.test.js: PASS');
};

run();
