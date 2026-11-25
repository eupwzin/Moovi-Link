#!/usr/bin/env node
'use strict';

// Sends the Moovi app-update push to the `app_updates` FCM topic.
// Secrets stay in environment variables and are never printed.

const crypto = require('node:crypto');

function b64url(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fail(message) {
  console.error(`[moovi-update] ${message}`);
  process.exit(1);
}

async function main() {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!rawServiceAccount) fail('FIREBASE_SERVICE_ACCOUNT_JSON is missing');

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawServiceAccount);
  } catch {
    fail('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    fail('Firebase service account is incomplete');
  }

  const releaseTag = (process.env.RELEASE_TAG || '').trim();
  if (!releaseTag) fail('RELEASE_TAG is missing');
  const version = releaseTag.replace(/^v/i, '');
  const downloadUrl =
    `https://github.com/eupwzin/Moovi-Link/releases/download/${releaseTag}/Moovi-${version}.apk`;

  const releaseNotes = (process.env.RELEASE_BODY || '').trim();
  const safeNotes = releaseNotes.length > 900
    ? `${releaseNotes.slice(0, 897)}...`
    : releaseNotes || 'Melhorias em: Geral, Player e Continue assistindo.';

  // 1. Mint an OAuth access token for the FCM scope.
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = b64url(signer.sign(serviceAccount.private_key));
  const jwt = `${unsigned}.${signature}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const tokenJson = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenJson.access_token) {
    fail(`FCM token request failed (${tokenResponse.status})`);
  }

  // 2. Send the data message to the public topic.
  const payload = {
    message: {
      topic: 'app_updates',
      data: {
        type: 'app_update',
        version,
        downloadUrl,
        releaseNotes: safeNotes,
      },
    },
  };

  const sendResponse = await fetch(
    `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
  );
  const sendJson = await sendResponse.json();
  if (!sendResponse.ok) {
    fail(`FCM send failed (${sendResponse.status})`);
  }

  console.log(`[moovi-update] sent ${sendJson.name || 'ok'} for ${version}`);
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
